import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { PgErrorCode } from '../../../lib/error';
import { type ILogger } from '../../../lib/logger';
import { type IObjectStorage } from '../../../pkg/storage';
import { toMs, TimeUnit } from '../../../pkg/time';
import { MEDIA_PROCESSING_STUCK_AFTER_MS, MEDIA_STUCK_LOG_SAMPLE, MediaLogEvent } from '../constants';
import { MediaStatus } from '../enums';
import { type MediaObject } from '../model/media-object.model';
import { type MediaObjectRepository } from '../repository/media-object.repository';
import { processedKeys, uploadKey } from './storage-keys';

export interface MediaCleanupSettings {
  retentionHours: number;
  batchSize: number;
}

const STILL_REFERENCED = new Set<string>([PgErrorCode.FOREIGN_KEY_VIOLATION, PgErrorCode.RESTRICT_VIOLATION]);

const isStillReferenced = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  STILL_REFERENCED.has(String((error as { code?: unknown }).code));

/** The objects a deleted row leaves behind (spec 14 §1.1). */
function objectKeysOf(media: MediaObject): string[] {
  if (media.status === MediaStatus.PENDING) return [uploadKey(media.id)];
  if (media.status === MediaStatus.READY) return processedKeys(media.id, media.purpose);
  // failed: the original was deleted when it failed.
  return [];
}

/**
 * `media-cleanup` (spec 14 UC-ME-4, worker, advisory-locked). Candidates are read without locks; each
 * row is then handled in its own short transaction under `FOR UPDATE SKIP LOCKED`, and its objects are
 * deleted only after that commits. A released row still referenced by another FK is kept for good
 * (`retained_at`, ME-4).
 */
@injectable()
export class MediaCleanupJob {
  private readonly logger: ILogger;

  constructor(
    @inject(TOKENS.MediaObjectRepository) private readonly media: MediaObjectRepository,
    @inject(TOKENS.ObjectStorage) private readonly storage: IObjectStorage,
    @inject(TOKENS.TransactionRunner) private readonly transactions: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Logger) logger: ILogger,
  ) {
    this.logger = logger.child({ module: 'media', job: 'media-cleanup' });
  }

  /** Returns the number of rows deleted or retained. */
  async run(settings: MediaCleanupSettings): Promise<number> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - toMs(settings.retentionHours, TimeUnit.HOUR));
    let handled = 0;

    for (const { id } of await this.media.listUnclaimedBefore(cutoff, settings.batchSize)) {
      if (
        await this.handle(
          id,
          (row) => row.claimedAt === null && row.status !== MediaStatus.PROCESSING && row.createdAt < cutoff,
        )
      ) {
        handled += 1;
      }
    }
    for (const { id } of await this.media.listReleased(settings.batchSize)) {
      if (await this.handle(id, (row) => row.releasedAt !== null && row.retainedAt === null)) handled += 1;
    }

    await this.reportStuck(now);
    return handled;
  }

  /** One row: re-checked under its lock, then deleted (or retained); its objects after the commit. */
  private async handle(id: string, isCandidate: (row: MediaObject) => boolean): Promise<boolean> {
    const deleted = await this.transactions.run(async (trx) => {
      const row = await this.media.lockForCleanup(id, trx);
      if (!row || !isCandidate(row)) return null;
      if (row.releasedAt === null) {
        await this.media.deleteById(row.id, trx);
        return row;
      }
      return (await this.deleteUnlessReferenced(row, trx)) ? row : undefined;
    });
    if (deleted === null) return false;
    if (deleted) await this.deleteObjects(deleted);
    return true;
  }

  /** In a savepoint: an FK still pointing at the row (e.g. an order item snapshot) keeps it. */
  private async deleteUnlessReferenced(row: MediaObject, trx: DbTransaction): Promise<boolean> {
    try {
      await trx.transaction((savepoint) => this.media.deleteById(row.id, savepoint));
      return true;
    } catch (error) {
      if (!isStillReferenced(error)) throw error;
      await this.media.markRetained(row.id, this.clock.now(), trx);
      this.logger.info('released media retained: still referenced', { mediaId: row.id });
      return false;
    }
  }

  /** A failed delete leaves an orphan object: storage cost only, never a broken image (ME-5). */
  private async deleteObjects(media: MediaObject): Promise<void> {
    for (const key of objectKeysOf(media)) {
      try {
        await this.storage.delete(key);
      } catch (error) {
        this.logger.warn('media object delete failed', {
          event: MediaLogEvent.OBJECT_DELETE_FAILED,
          mediaId: media.id,
          key,
          error,
        });
      }
    }
  }

  /** A processing row is never cleaned up; one untouched for an hour is an incident (alarm). */
  private async reportStuck(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - MEDIA_PROCESSING_STUCK_AFTER_MS);
    const stuck = await this.media.listStuckProcessing(cutoff, MEDIA_STUCK_LOG_SAMPLE);
    if (stuck.total === 0) return;
    this.logger.error('media stuck in processing', {
      event: MediaLogEvent.PROCESSING_STUCK,
      count: stuck.total,
      mediaIds: stuck.ids,
    });
  }
}
