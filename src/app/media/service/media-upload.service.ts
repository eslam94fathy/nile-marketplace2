import { inject, injectable } from 'tsyringe';
import { type UserRole } from '../../../lib/auth';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { serviceUnavailable, validationFailed } from '../../../lib/error';
import { type IOutbox, MediaUploaded } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { detectImageType, type ImageContentType, MAGIC_BYTES_LENGTH } from '../../../pkg/image';
import { type IObjectStorage, ObjectStorageError, type PresignedPost } from '../../../pkg/storage';
import { toMs, TimeUnit } from '../../../pkg/time';
import { MediaLogEvent } from '../constants';
import { MediaFailureReason, type MediaPurpose, MediaStatus, PURPOSE_RULES } from '../enums';
import {
  mediaInvalidStatus,
  mediaNotFound,
  mediaOpenUploadLimitReached,
  mediaPurposeNotAllowed,
  mediaUploadInvalid,
  mediaUploadMissing,
} from '../errors';
import { type MediaObject } from '../model/media-object.model';
import { type MediaObjectRepository } from '../repository/media-object.repository';
import { type ImageView, type MediaUrls } from './media-urls';
import { uploadKey } from './storage-keys';

export interface Uploader {
  userId: string;
  role: UserRole;
}

export interface UploadRequest {
  purpose: MediaPurpose;
  contentType: ImageContentType;
  sizeBytes: number;
}

export interface MediaView {
  media: MediaObject;
  image: ImageView | null;
}

export interface UploadTicket extends MediaView {
  upload: PresignedPost & { expiresAt: Date };
}

/** `accepted`: this call moved the upload to processing (202); otherwise it already was (200). */
export interface CompleteResult extends MediaView {
  accepted: boolean;
}

type UploadEnv = Pick<
  Env,
  'MEDIA_MAX_UPLOAD_BYTES' | 'MEDIA_UPLOAD_URL_TTL_SECONDS' | 'MEDIA_MAX_OPEN_UPLOADS_PER_USER'
>;

/** Spec 14 UC-ME-1, UC-ME-2 and `GET /media/:id` (api). The api never receives image bytes. */
@injectable()
export class MediaUploadService {
  private readonly logger: ILogger;

  constructor(
    @inject(TOKENS.MediaObjectRepository) private readonly media: MediaObjectRepository,
    @inject(TOKENS.MediaUrls) private readonly urls: MediaUrls,
    @inject(TOKENS.ObjectStorage) private readonly storage: IObjectStorage,
    @inject(TOKENS.TransactionRunner) private readonly transactions: ITransactionRunner,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Env) private readonly env: UploadEnv,
    @inject(TOKENS.Logger) logger: ILogger,
  ) {
    this.logger = logger.child({ module: 'media' });
  }

  /** UC-ME-1. The open-upload count is a soft cap: a race may pass it by a few rows. */
  async requestUpload(uploader: Uploader, request: UploadRequest): Promise<UploadTicket> {
    if (request.sizeBytes > this.env.MEDIA_MAX_UPLOAD_BYTES) {
      throw validationFailed([
        {
          field: 'sizeBytes',
          constraint: 'max',
          message: `sizeBytes must not be greater than ${this.env.MEDIA_MAX_UPLOAD_BYTES}`,
        },
      ]);
    }
    if (!PURPOSE_RULES[request.purpose].roles.includes(uploader.role)) throw mediaPurposeNotAllowed();
    const open = await this.media.countOpenByOwner(uploader.userId);
    if (open >= this.env.MEDIA_MAX_OPEN_UPLOADS_PER_USER) throw mediaOpenUploadLimitReached();

    const media = await this.media.insert({
      ownerUserId: uploader.userId,
      purpose: request.purpose,
      declaredContentType: request.contentType,
      declaredSizeBytes: request.sizeBytes,
    });
    const expiresAt = new Date(
      this.clock.now().getTime() + toMs(this.env.MEDIA_UPLOAD_URL_TTL_SECONDS, TimeUnit.SECOND),
    );
    const post = await this.storage.presignPost({
      key: uploadKey(media.id),
      contentType: request.contentType,
      maxBytes: this.env.MEDIA_MAX_UPLOAD_BYTES,
      expiresInSeconds: this.env.MEDIA_UPLOAD_URL_TTL_SECONDS,
    });
    return { media, image: null, upload: { ...post, expiresAt } };
  }

  /** UC-ME-2. Storage is checked outside any transaction; the status change and its event commit together. */
  async complete(userId: string, mediaId: string): Promise<CompleteResult> {
    const media = await this.ownMedia(userId, mediaId);
    if (media.status !== MediaStatus.PENDING) return this.answerExisting(media);

    const verdict = await this.inspectUpload(media);
    if (verdict === 'invalid') {
      if (
        !(await this.media.markFailed(media.id, MediaStatus.PENDING, MediaFailureReason.UNSUPPORTED_TYPE))
      ) {
        return this.answerExisting(await this.ownMedia(userId, mediaId));
      }
      await this.deleteQuietly(uploadKey(media.id), media.id);
      throw mediaUploadInvalid();
    }

    const moved = await this.transactions.run(async (trx) => {
      if (!(await this.media.markProcessing(media.id, trx))) return false;
      await this.outbox.add(trx, {
        contract: MediaUploaded,
        aggregateId: media.id,
        payload: { mediaId: media.id, purpose: media.purpose, ownerUserId: media.ownerUserId },
      });
      return true;
    });
    const current = await this.ownMedia(userId, mediaId);
    if (!moved) return this.answerExisting(current);
    return { media: current, image: null, accepted: true };
  }

  /** The uploader only (for polling until the realtime `media.ready` push). */
  async get(userId: string, mediaId: string): Promise<MediaView> {
    const media = await this.ownMedia(userId, mediaId);
    return { media, image: await this.urls.imageOf(media) };
  }

  private async ownMedia(userId: string, mediaId: string): Promise<MediaObject> {
    const media = await this.media.findById(mediaId);
    if (!media || media.ownerUserId !== userId) throw mediaNotFound();
    return media;
  }

  /** A retried complete after a lost response gets the current state; a failed upload can't be completed. */
  private async answerExisting(media: MediaObject): Promise<CompleteResult> {
    if (media.status === MediaStatus.FAILED) throw mediaInvalidStatus();
    if (media.status === MediaStatus.PENDING) throw mediaUploadMissing();
    return { media, image: await this.urls.imageOf(media), accepted: false };
  }

  /** HEAD, then the first bytes against the declared type (UC-ME-2 step 3). */
  private async inspectUpload(media: MediaObject): Promise<'valid' | 'invalid'> {
    const key = uploadKey(media.id);
    try {
      const head = await this.storage.head(key);
      if (!head) throw mediaUploadMissing();
      if (head.sizeBytes > this.env.MEDIA_MAX_UPLOAD_BYTES) return 'invalid';
      const first = await this.storage.getRange(key, 0, MAGIC_BYTES_LENGTH - 1);
      return detectImageType(first) === media.declaredContentType ? 'valid' : 'invalid';
    } catch (error) {
      if (error instanceof ObjectStorageError) {
        // Gone between the HEAD and the read: the client may upload again until the URL expires.
        if (error.kind === 'not_found') throw mediaUploadMissing();
        throw serviceUnavailable(error);
      }
      throw error;
    }
  }

  /** The bucket's lifecycle rule removes what this misses (spec 14 §1.1, ME-5). */
  private async deleteQuietly(key: string, mediaId: string): Promise<void> {
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
