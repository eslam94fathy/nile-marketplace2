import { UserRole } from '../../lib/auth';
import { type MediaFailureReasonValue, type MediaPurposeValue } from '../../lib/events';

/** Spec 14 §1. Mirrors the event value types in lib/events (kept assignable). */
export const MediaPurpose = {
  PRODUCT_IMAGE: 'product_image',
  CATEGORY_IMAGE: 'category_image',
  SUPPORT_ATTACHMENT: 'support_attachment',
  REVIEW_IMAGE: 'review_image',
  RETURN_PHOTO: 'return_photo',
} as const satisfies Record<string, MediaPurposeValue>;
export type MediaPurpose = (typeof MediaPurpose)[keyof typeof MediaPurpose];

export const MediaStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
} as const;
export type MediaStatus = (typeof MediaStatus)[keyof typeof MediaStatus];

export const MediaFailureReason = {
  DECODE_FAILED: 'decode_failed',
  UNSUPPORTED_TYPE: 'unsupported_type',
  DIMENSIONS_OUT_OF_RANGE: 'dimensions_out_of_range',
} as const satisfies Record<string, MediaFailureReasonValue>;
export type MediaFailureReason = (typeof MediaFailureReason)[keyof typeof MediaFailureReason];

/** Processed WebP sizes: name → width in px (R-1). */
export const ImageSize = {
  THUMB: 'thumb',
  MEDIUM: 'medium',
  LARGE: 'large',
} as const;
export type ImageSize = (typeof ImageSize)[keyof typeof ImageSize];

/** The storage prefix of processed images (spec 14 §1.1, ME-1). */
export const MediaVisibility = { PUBLIC: 'public', PRIVATE: 'private' } as const;
export type MediaVisibility = (typeof MediaVisibility)[keyof typeof MediaVisibility];

interface PurposeRule {
  roles: readonly UserRole[];
  visibility: MediaVisibility;
}

/** Who may upload each purpose and where its images live (spec 14 §1). */
export const PURPOSE_RULES: Readonly<Record<MediaPurpose, PurposeRule>> = {
  [MediaPurpose.PRODUCT_IMAGE]: { roles: [UserRole.SELLER], visibility: MediaVisibility.PUBLIC },
  [MediaPurpose.CATEGORY_IMAGE]: { roles: [UserRole.ADMIN], visibility: MediaVisibility.PUBLIC },
  [MediaPurpose.REVIEW_IMAGE]: { roles: [UserRole.CUSTOMER], visibility: MediaVisibility.PUBLIC },
  [MediaPurpose.SUPPORT_ATTACHMENT]: {
    roles: [UserRole.CUSTOMER, UserRole.SELLER, UserRole.ADMIN],
    visibility: MediaVisibility.PRIVATE,
  },
  // The seller's own uploads back a dispute (spec 14 ME-14, spec 18 UC-RE-8).
  [MediaPurpose.RETURN_PHOTO]: {
    roles: [UserRole.CUSTOMER, UserRole.SELLER],
    visibility: MediaVisibility.PRIVATE,
  },
};
