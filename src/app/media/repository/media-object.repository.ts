import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ImageContentType } from '../../../pkg/image';
import { MEDIA_TABLES } from '../constants';
import { type MediaFailureReason, type MediaPurpose, MediaStatus } from '../enums';
import { type MediaObject, type NewMediaObject, type ReadyImage } from '../model/media-object.model';

const T = MEDIA_TABLES.MEDIA_OBJECTS;
const COLUMNS = [
  'id',
  'owner_user_id',
  'purpose',
  'status',
  'failure_reason',
  'declared_content_type',
  'declared_size_bytes',
  'width',
  'height',
  'processed_at',
  'claimed_at',
  'released_at',
  'retained_at',
  'created_at',
  'updated_at',
] as const;

interface MediaObjectRow {
  id: string;
  owner_user_id: string;
  purpose: MediaPurpose;
  status: MediaStatus;
  failure_reason: MediaFailureReason | null;
  declared_content_type: ImageContentType;
  declared_size_bytes: number;
  width: number | null;
  height: number | null;
  processed_at: Date | null;
  claimed_at: Date | null;
  released_at: Date | null;
  retained_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toModel(row: MediaObjectRow): MediaObject {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    purpose: row.purpose,
    status: row.status,
    failureReason: row.failure_reason,
    declaredContentType: row.declared_content_type,
    declaredSizeBytes: row.declared_size_bytes,
    width: row.width,
    height: row.height,
    processedAt: row.processed_at,
    claimedAt: row.claimed_at,
    releasedAt: row.released_at,
    retainedAt: row.retained_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A cleanup candidate as listed (unlocked) by the job; re-checked under its row lock. */
export interface CleanupCandidate {
  id: string;
}

/** All SQL of `media_objects` (spec 14). */
@injectable()
export class MediaObjectRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async insert(media: NewMediaObject, trx?: DbTransaction): Promise<MediaObject> {
    const [row] = await this.exec(trx)<MediaObjectRow>(T)
      .insert({
        owner_user_id: media.ownerUserId,
        purpose: media.purpose,
        status: MediaStatus.PENDING,
        failure_reason: null,
        declared_content_type: media.declaredContentType,
        declared_size_bytes: media.declaredSizeBytes,
        width: null,
        height: null,
        processed_at: null,
        claimed_at: null,
        released_at: null,
        retained_at: null,
      })
      .returning<MediaObjectRow[]>(COLUMNS);
    if (!row) throw new Error('media_objects insert returned no row');
    return toModel(row);
  }

  async findById(id: string, trx?: DbTransaction): Promise<MediaObject | null> {
    const row = await this.exec(trx)<MediaObjectRow>(T)
      .select(...COLUMNS)
      .where({ id })
      .first();
    return row ? toModel(row) : null;
  }

  /** Ready rows among `ids`, in one query (G20). */
  async findReadyByIds(ids: readonly string[], trx?: DbTransaction): Promise<MediaObject[]> {
    if (ids.length === 0) return [];
    const rows = await this.exec(trx)<MediaObjectRow>(T)
      .select(...COLUMNS)
      .whereIn('id', [...ids])
      .andWhere({ status: MediaStatus.READY });
    return rows.map(toModel);
  }

  /** Uses idx_media_objects_owner_user_id_open (UC-ME-1). */
  async countOpenByOwner(ownerUserId: string): Promise<number> {
    const row = await this.db
      .knex(T)
      .where({ owner_user_id: ownerUserId })
      .whereIn('status', [MediaStatus.PENDING, MediaStatus.PROCESSING])
      .count<{ count: string }[]>({ count: '*' })
      .first();
    return Number(row?.count ?? 0);
  }

  /** `pending` → `processing` (UC-ME-2 step 4). False when the row was no longer pending. */
  async markProcessing(id: string, trx: DbTransaction): Promise<boolean> {
    const updated = await trx(T)
      .where({ id, status: MediaStatus.PENDING })
      .update({ status: MediaStatus.PROCESSING, updated_at: trx.fn.now() });
    return updated > 0;
  }

  /** `from` → `failed` with its reason. False when the row had already left `from`. */
  async markFailed(
    id: string,
    from: typeof MediaStatus.PENDING | typeof MediaStatus.PROCESSING,
    reason: MediaFailureReason,
    trx?: DbTransaction,
  ): Promise<boolean> {
    const exec = this.exec(trx);
    const updated = await exec(T)
      .where({ id, status: from })
      .update({ status: MediaStatus.FAILED, failure_reason: reason, updated_at: exec.fn.now() });
    return updated > 0;
  }

  /** `processing` → `ready` (UC-ME-3 step 4). False when the row was no longer processing. */
  async markReady(id: string, image: ReadyImage, processedAt: Date, trx: DbTransaction): Promise<boolean> {
    const updated = await trx(T).where({ id, status: MediaStatus.PROCESSING }).update({
      status: MediaStatus.READY,
      width: image.width,
      height: image.height,
      processed_at: processedAt,
      updated_at: trx.fn.now(),
    });
    return updated > 0;
  }

  /** `claim`: the rows locked in id order (architecture §14.3 lock order). */
  async lockByIds(ids: readonly string[], trx: DbTransaction): Promise<MediaObject[]> {
    const rows = await trx<MediaObjectRow>(T)
      .select(...COLUMNS)
      .whereIn('id', [...ids])
      .orderBy('id')
      .forUpdate();
    return rows.map(toModel);
  }

  async setClaimed(ids: readonly string[], claimedAt: Date, trx: DbTransaction): Promise<void> {
    await trx(T)
      .whereIn('id', [...ids])
      .update({ claimed_at: claimedAt, updated_at: trx.fn.now() });
  }

  /** Only claimed, not yet released rows; returns how many were released. */
  async setReleased(ids: readonly string[], releasedAt: Date, trx: DbTransaction): Promise<number> {
    return trx(T)
      .whereIn('id', [...ids])
      .whereNotNull('claimed_at')
      .whereNull('released_at')
      .update({ released_at: releasedAt, updated_at: trx.fn.now() });
  }

  /**
   * Unclaimed `pending` / `ready` / `failed` rows created before `cutoff`, oldest first
   * (idx_media_objects_cleanup). Read without locks (UC-ME-4).
   */
  async listUnclaimedBefore(cutoff: Date, limit: number): Promise<CleanupCandidate[]> {
    return this.db
      .knex(T)
      .select<CleanupCandidate[]>('id')
      .whereNull('claimed_at')
      .whereNot({ status: MediaStatus.PROCESSING })
      .andWhere('created_at', '<', cutoff)
      .orderBy([{ column: 'created_at' }, { column: 'id' }])
      .limit(limit);
  }

  /** Released rows not yet retained, oldest release first (idx_media_objects_released). */
  async listReleased(limit: number): Promise<CleanupCandidate[]> {
    return this.db
      .knex(T)
      .select<CleanupCandidate[]>('id')
      .whereNotNull('released_at')
      .whereNull('retained_at')
      .orderBy([{ column: 'released_at' }, { column: 'id' }])
      .limit(limit);
  }

  /** `FOR UPDATE SKIP LOCKED`: null when another worker holds the row or it is gone. */
  async lockForCleanup(id: string, trx: DbTransaction): Promise<MediaObject | null> {
    const row = await trx<MediaObjectRow>(T)
      .select(...COLUMNS)
      .where({ id })
      .forUpdate()
      .skipLocked()
      .first();
    return row ? toModel(row) : null;
  }

  async deleteById(id: string, trx: DbTransaction): Promise<void> {
    await trx(T).where({ id }).del();
  }

  /** A released row another module still references: kept for good (ME-4). */
  async markRetained(id: string, retainedAt: Date, trx: DbTransaction): Promise<void> {
    await trx(T).where({ id }).update({ retained_at: retainedAt, updated_at: trx.fn.now() });
  }

  /** `processing` rows untouched since `cutoff` (idx_media_objects_processing). */
  async listStuckProcessing(cutoff: Date, limit: number): Promise<{ ids: string[]; total: number }> {
    const base = () =>
      this.db.knex(T).where({ status: MediaStatus.PROCESSING }).andWhere('updated_at', '<', cutoff);
    const [rows, count] = await Promise.all([
      base().select<{ id: string }[]>('id').orderBy('updated_at').limit(limit),
      base().count<{ count: string }[]>({ count: '*' }).first(),
    ]);
    return { ids: rows.map((row) => row.id), total: Number(count?.count ?? 0) };
  }
}
