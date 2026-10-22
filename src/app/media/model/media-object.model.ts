import { type ImageContentType } from '../../../pkg/image';
import { type MediaFailureReason, type MediaPurpose, type MediaStatus } from '../enums';

/** One row of `media_objects` (spec 14 §1, database v2.0 §14.3). */
export interface MediaObject {
  id: string;
  ownerUserId: string;
  purpose: MediaPurpose;
  status: MediaStatus;
  failureReason: MediaFailureReason | null;
  declaredContentType: ImageContentType;
  declaredSizeBytes: number;
  /** Of the processed large image; set once ready. */
  width: number | null;
  height: number | null;
  processedAt: Date | null;
  claimedAt: Date | null;
  releasedAt: Date | null;
  retainedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewMediaObject {
  ownerUserId: string;
  purpose: MediaPurpose;
  declaredContentType: ImageContentType;
  declaredSizeBytes: number;
}

/** A ready image's dimensions. */
export interface ReadyImage {
  width: number;
  height: number;
}
