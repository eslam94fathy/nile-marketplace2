import { ImageContentType } from '../../pkg/image';
import { toMs, TimeUnit } from '../../pkg/time';
import { ImageSize } from './enums';

export const MEDIA_TABLES = {
  MEDIA_OBJECTS: 'media_objects',
} as const;

/** Paths under /api/v1 (spec 14 §4). */
export const MEDIA_PATHS = {
  UPLOADS: '/media/uploads',
  COMPLETE: '/media/uploads/:mediaId/complete',
  MEDIA: '/media/:mediaId',
} as const;

/** Accepted upload types (R-1). */
export const UPLOAD_CONTENT_TYPES = [
  ImageContentType.JPEG,
  ImageContentType.PNG,
  ImageContentType.WEBP,
] as const;

/** Processed widths in px; the aspect ratio is kept and images are never upscaled (spec 14 §1). */
export const IMAGE_SIZE_WIDTHS: Readonly<Record<ImageSize, number>> = {
  [ImageSize.THUMB]: 200,
  [ImageSize.MEDIUM]: 600,
  [ImageSize.LARGE]: 1200,
};

/** Processing limits (spec 14 §1): the minimum size, the decompression-bomb guard, the WebP quality. */
export const IMAGE_LIMITS = {
  MIN_WIDTH: 200,
  MIN_HEIGHT: 200,
  MAX_PIXELS: 50_000_000,
  WEBP_QUALITY: 80,
} as const;

/** Public keys never change once written, so CDNs and browsers may cache them forever (spec 14 §1.1). */
export const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const PRIVATE_CACHE_CONTROL = 'private, no-store';
export const PROCESSED_CONTENT_TYPE = 'image/webp';

/** The queue of `media.uploaded`; CPU-heavy, so one message at a time per worker (architecture A-6). */
export const MEDIA_PROCESSING_QUEUE = 'media.processing';
export const MEDIA_PROCESSING_PREFETCH = 1;

export const MEDIA_CLEANUP_JOB = 'media-cleanup';
/** A `processing` row older than this is logged as stuck (UC-ME-4). */
export const MEDIA_PROCESSING_STUCK_AFTER_MS = toMs(1, TimeUnit.HOUR);
/** How many stuck ids one log line lists. */
export const MEDIA_STUCK_LOG_SAMPLE = 20;

/** Log event codes (spec 14 §6). */
export const MediaLogEvent = {
  OBJECT_DELETE_FAILED: 'MEDIA_OBJECT_DELETE_FAILED',
  PROCESSING_STUCK: 'MEDIA_PROCESSING_STUCK',
} as const;
