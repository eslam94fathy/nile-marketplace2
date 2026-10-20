import { ImageSize, type MediaPurpose, type MediaVisibility, PURPOSE_RULES } from '../enums';

/** Storage keys derive from id and purpose and are never stored (spec 14 §1.1, database v2.0 §14.3). */

export const IMAGE_SIZES: readonly ImageSize[] = [ImageSize.THUMB, ImageSize.MEDIUM, ImageSize.LARGE];

/** The processor echoes the output names it was given: anything else is a bug. */
export function asImageSize(name: string): ImageSize {
  const size = IMAGE_SIZES.find((candidate) => candidate === name);
  if (!size) throw new Error(`unknown image size ${name}`);
  return size;
}

export const uploadKey = (mediaId: string): string => `uploads/${mediaId}`;

export const visibilityOf = (purpose: MediaPurpose): MediaVisibility => PURPOSE_RULES[purpose].visibility;

export const processedKey = (mediaId: string, purpose: MediaPurpose, size: ImageSize): string =>
  `${visibilityOf(purpose)}/${mediaId}/${size}.webp`;

export const processedKeys = (mediaId: string, purpose: MediaPurpose): string[] =>
  IMAGE_SIZES.map((size) => processedKey(mediaId, purpose, size));
