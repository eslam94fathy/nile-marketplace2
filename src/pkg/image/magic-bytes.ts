/** Upload content types (spec 14 §1, R-1). */
export const ImageContentType = {
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  WEBP: 'image/webp',
} as const;
export type ImageContentType = (typeof ImageContentType)[keyof typeof ImageContentType];

/** How many leading bytes `detectImageType` needs. */
export const MAGIC_BYTES_LENGTH = 16;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(head: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  return bytes.every((byte, index) => head[offset + index] === byte);
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

/**
 * The image type the leading bytes say the file is, or `null` (spec 14 UC-ME-2 step 3). The declared
 * `Content-Type` is the client's claim; this is what the bytes are.
 */
export function detectImageType(head: Uint8Array): ImageContentType | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return ImageContentType.JPEG;
  if (startsWith(head, PNG_SIGNATURE)) return ImageContentType.PNG;
  // RIFF <4-byte size> WEBP
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return ImageContentType.WEBP;
  return null;
}
