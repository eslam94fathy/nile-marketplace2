import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ErrorDetail } from '../../../lib/error';
import { MediaPurpose, MediaStatus } from '../enums';
import { mediaNotAttachable } from '../errors';
import { type MediaObject } from '../model/media-object.model';
import { type MediaObjectRepository } from '../repository/media-object.repository';
import { type ImageView, type MediaUrls } from './media-urls';

export interface ClaimOptions {
  purpose: MediaPurpose;
  /** The user attaching the media: they must have uploaded it (category images excepted, ME-2). */
  ownerUserId: string;
}

/** Why one id can't be claimed: the `constraint` of its error detail. */
export const NotAttachableReason = {
  /** Missing, or uploaded by someone else (not told apart, like MEDIA_NOT_FOUND). */
  NOT_FOUND: 'not_found',
  NOT_READY: 'not_ready',
  WRONG_PURPOSE: 'wrong_purpose',
  ALREADY_CLAIMED: 'already_claimed',
  DUPLICATE: 'duplicate',
} as const;
type NotAttachableReason = (typeof NotAttachableReason)[keyof typeof NotAttachableReason];

const REASON_MESSAGES: Readonly<Record<NotAttachableReason, string>> = {
  not_found: 'media not found',
  not_ready: 'media is not ready',
  wrong_purpose: 'media was uploaded for another purpose',
  already_claimed: 'media is already attached',
  duplicate: 'media is listed twice',
};

/**
 * Public API of media (spec 14 §2) for the owning modules (catalog, support, reviews, returns).
 * They keep their own reference rows with an FK to `media_objects` (`ON DELETE RESTRICT`).
 */
@injectable()
export class MediaService {
  constructor(
    @inject(TOKENS.MediaObjectRepository) private readonly media: MediaObjectRepository,
    @inject(TOKENS.MediaUrls) private readonly urls: MediaUrls,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  /**
   * Attaches media in the caller's transaction: locks the rows in id order; each must be ready, of
   * `purpose`, uploaded by `ownerUserId` and unclaimed, else `422 MEDIA_NOT_ATTACHABLE` (one detail
   * per bad id) and nothing is claimed.
   */
  async claim(mediaIds: readonly string[], options: ClaimOptions, trx: DbTransaction): Promise<void> {
    if (mediaIds.length === 0) return;
    const rows = new Map((await this.media.lockByIds(mediaIds, trx)).map((row) => [row.id, row]));
    const seen = new Set<string>();
    const details: ErrorDetail[] = [];
    mediaIds.forEach((id, index) => {
      const reason = seen.has(id) ? NotAttachableReason.DUPLICATE : this.problemOf(rows.get(id), options);
      seen.add(id);
      if (reason) {
        details.push({
          field: `mediaIds[${index}]`,
          constraint: reason,
          message: REASON_MESSAGES[reason],
          value: id,
        });
      }
    });
    if (details.length > 0) throw mediaNotAttachable(details);
    await this.media.setClaimed([...seen], this.clock.now(), trx);
  }

  /**
   * Detaches media; the caller has already deleted its reference rows in `trx`. The cleanup job deletes
   * the media later unless another reference still holds it (UC-ME-4).
   */
  async release(mediaIds: readonly string[], trx: DbTransaction): Promise<void> {
    if (mediaIds.length === 0) return;
    await this.media.setReleased(mediaIds, this.clock.now(), trx);
  }

  /**
   * One batched read. Ids that aren't ready are left out. Private images get presigned URLs: the
   * caller has already authorised the viewer.
   */
  async getImages(mediaIds: readonly string[]): Promise<Map<string, ImageView>> {
    const rows = await this.media.findReadyByIds([...new Set(mediaIds)]);
    const images = await Promise.all(rows.map((row) => this.urls.imageOf(row)));
    return new Map(images.flatMap((image) => (image ? [[image.id, image] as const] : [])));
  }

  private problemOf(row: MediaObject | undefined, options: ClaimOptions): NotAttachableReason | null {
    const anyAdminMayClaim = options.purpose === MediaPurpose.CATEGORY_IMAGE;
    if (!row || (!anyAdminMayClaim && row.ownerUserId !== options.ownerUserId)) {
      return NotAttachableReason.NOT_FOUND;
    }
    if (row.purpose !== options.purpose) return NotAttachableReason.WRONG_PURPOSE;
    if (row.status !== MediaStatus.READY) return NotAttachableReason.NOT_READY;
    if (row.claimedAt !== null) return NotAttachableReason.ALREADY_CLAIMED;
    return null;
  }
}
