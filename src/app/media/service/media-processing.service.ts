import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { afterCommit, type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import {
  type EventEnvelope,
  type IOutbox,
  MediaFailed,
  MediaReady,
  type MediaUploadedPayload,
  PermanentEventError,
} from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import {
  detectImageType,
  type IImageProcessor,
  ImageRejectedError,
  MAGIC_BYTES_LENGTH,
  type ProcessedImage,
} from '../../../pkg/image';
import { type IObjectStorage, ObjectStorageError } from '../../../pkg/storage';
import {
  IMAGE_LIMITS,
  IMAGE_SIZE_WIDTHS,
  MediaLogEvent,
  PRIVATE_CACHE_CONTROL,
  PROCESSED_CONTENT_TYPE,
  PUBLIC_CACHE_CONTROL,
} from '../constants';
import { MediaFailureReason, MediaStatus, MediaVisibility } from '../enums';
import { type MediaObject } from '../model/media-object.model';
import { type MediaObjectRepository } from '../repository/media-object.repository';
import { asImageSize, IMAGE_SIZES, processedKey, uploadKey, visibilityOf } from './storage-keys';

/** What the work outside the transaction found (UC-ME-3 step 3). */
export type ProcessingOutcome =
  | { kind: 'skip' }
  | { kind: 'ready'; media: MediaObject; width: number; height: number }
  | { kind: 'failed'; media: MediaObject; reason: MediaFailureReason };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROCESS_OPTIONS = {
  outputs: IMAGE_SIZES.map((size) => ({ name: size, width: IMAGE_SIZE_WIDTHS[size] })),
  minWidth: IMAGE_LIMITS.MIN_WIDTH,
  minHeight: IMAGE_LIMITS.MIN_HEIGHT,
  maxPixels: IMAGE_LIMITS.MAX_PIXELS,
  webpQuality: IMAGE_LIMITS.WEBP_QUALITY,
} as const;

function mediaIdOf(envelope: EventEnvelope): string {
  const { mediaId } = envelope.payload as Partial<MediaUploadedPayload>;
  if (typeof mediaId !== 'string' || !UUID_PATTERN.test(mediaId)) {
    throw new PermanentEventError('media.uploaded payload has no valid mediaId');
  }
  return mediaId;
}

/**
 * Consumer `media.processing` ← `media.uploaded` (spec 14 UC-ME-3, worker). Decoding and the storage
 * writes run outside the transaction (`beforeTransaction`, P1-I4); a redelivery rewrites the same keys
 * with the same bytes. Storage errors are transient (retry, then DLQ); an unusable image is permanent.
 */
@injectable()
export class MediaProcessingService {
  private readonly logger: ILogger;

  constructor(
    @inject(TOKENS.MediaObjectRepository) private readonly media: MediaObjectRepository,
    @inject(TOKENS.ObjectStorage) private readonly storage: IObjectStorage,
    @inject(TOKENS.ImageProcessor) private readonly images: IImageProcessor,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Logger) logger: ILogger,
  ) {
    this.logger = logger.child({ module: 'media' });
  }

  async process(envelope: EventEnvelope): Promise<ProcessingOutcome> {
    const media = await this.media.findById(mediaIdOf(envelope));
    // Done or failed already, or gone (cleanup never removes a processing row).
    if (!media || media.status !== MediaStatus.PROCESSING) return { kind: 'skip' };

    const original = await this.readOriginal(media);
    if (!original) return { kind: 'failed', media, reason: MediaFailureReason.DECODE_FAILED };
    // The presigned POST stays valid after complete, so the object may have been replaced since the
    // api checked it: check the bytes again (spec 14 ME-7).
    if (detectImageType(original.subarray(0, MAGIC_BYTES_LENGTH)) !== media.declaredContentType) {
      return { kind: 'failed', media, reason: MediaFailureReason.UNSUPPORTED_TYPE };
    }

    let processed: ProcessedImage;
    try {
      processed = await this.images.process(original, PROCESS_OPTIONS);
    } catch (error) {
      if (error instanceof ImageRejectedError) {
        this.logger.info('image rejected', { mediaId: media.id, reason: error.reason });
        return { kind: 'failed', media, reason: error.reason };
      }
      throw error;
    }

    const isPublic = visibilityOf(media.purpose) === MediaVisibility.PUBLIC;
    await Promise.all(
      processed.outputs.map((output) =>
        this.storage.put({
          key: processedKey(media.id, media.purpose, asImageSize(output.name)),
          body: output.data,
          contentType: PROCESSED_CONTENT_TYPE,
          cacheControl: isPublic ? PUBLIC_CACHE_CONTROL : PRIVATE_CACHE_CONTROL,
        }),
      ),
    );
    return { kind: 'ready', media, width: processed.width, height: processed.height };
  }

  /** In the consumer's transaction: the conditional status change and its event (UC-ME-3 step 4). */
  async record(outcome: ProcessingOutcome, trx: DbTransaction): Promise<void> {
    if (outcome.kind === 'skip') return;
    const { media } = outcome;
    const payload = { mediaId: media.id, purpose: media.purpose, ownerUserId: media.ownerUserId };

    if (outcome.kind === 'ready') {
      const image = { width: outcome.width, height: outcome.height };
      if (!(await this.media.markReady(media.id, image, this.clock.now(), trx))) return;
      await this.outbox.add(trx, { contract: MediaReady, aggregateId: media.id, payload });
    } else {
      if (!(await this.media.markFailed(media.id, MediaStatus.PROCESSING, outcome.reason, trx))) return;
      await this.outbox.add(trx, {
        contract: MediaFailed,
        aggregateId: media.id,
        payload: { ...payload, reason: outcome.reason },
      });
    }
    // The original is no longer needed either way; a failed delete is left to the lifecycle rule.
    afterCommit(trx, () => this.deleteOriginal(media.id));
    this.logger.info('media processed', { mediaId: media.id, status: outcome.kind });
  }

  /** `null` when the original is gone (e.g. removed by the lifecycle rule). Other storage errors retry. */
  private async readOriginal(media: MediaObject): Promise<Buffer | null> {
    try {
      return await this.storage.get(uploadKey(media.id));
    } catch (error) {
      if (error instanceof ObjectStorageError && error.kind === 'not_found') {
        this.logger.warn('media original missing', { mediaId: media.id });
        return null;
      }
      throw error;
    }
  }

  private async deleteOriginal(mediaId: string): Promise<void> {
    const key = uploadKey(mediaId);
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn('media object delete failed', {
        event: MediaLogEvent.OBJECT_DELETE_FAILED,
        mediaId,
        key,
        error,
      });
    }
  }
}
