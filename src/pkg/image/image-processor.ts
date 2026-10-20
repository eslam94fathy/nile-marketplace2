import sharp from 'sharp';

/** Why an image can never be processed (spec 14 `MediaFailureReason`). */
export const ImageRejection = {
  DECODE_FAILED: 'decode_failed',
  DIMENSIONS_OUT_OF_RANGE: 'dimensions_out_of_range',
} as const;
export type ImageRejection = (typeof ImageRejection)[keyof typeof ImageRejection];

/** A permanent failure: the bytes are not a usable image. Retrying cannot help. */
export class ImageRejectedError extends Error {
  override readonly name = 'ImageRejectedError';

  constructor(
    readonly reason: ImageRejection,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface ImageOutputSpec {
  name: string;
  /** Target width; the aspect ratio is kept and the image is never upscaled. */
  width: number;
}

export interface ProcessImageOptions {
  outputs: readonly ImageOutputSpec[];
  minWidth: number;
  minHeight: number;
  /** Decompression-bomb guard: decoding stops above this many pixels. */
  maxPixels: number;
  webpQuality: number;
}

export interface ProcessedOutput {
  name: string;
  width: number;
  height: number;
  data: Buffer;
}

export interface ProcessedImage {
  /** Of the largest output. */
  width: number;
  height: number;
  outputs: ProcessedOutput[];
}

/** Re-encodes an upload to fixed WebP sizes without metadata (spec 14 UC-ME-3). */
export interface IImageProcessor {
  process(input: Buffer, options: ProcessImageOptions): Promise<ProcessedImage>;
}

/** EXIF orientations 5–8 rotate by 90°, so width and height swap once `rotate()` applies them. */
const SWAPPING_ORIENTATIONS = new Set([5, 6, 7, 8]);

/**
 * `sharp` (libvips). `failOn: 'error'` refuses truncated or corrupt files; `limitInputPixels` refuses
 * oversized ones before decoding. The output carries no metadata: sharp drops EXIF (GPS included),
 * XMP and ICC unless asked to keep them, and converts to sRGB.
 */
export class SharpImageProcessor implements IImageProcessor {
  async process(input: Buffer, options: ProcessImageOptions): Promise<ProcessedImage> {
    const open = () => sharp(input, { failOn: 'error', limitInputPixels: options.maxPixels });

    let metadata: sharp.Metadata;
    try {
      metadata = await open().metadata();
    } catch (error) {
      throw this.rejection(error);
    }
    const { width, height } = orientedSize(metadata);
    if (width < options.minWidth || height < options.minHeight) {
      throw new ImageRejectedError(
        ImageRejection.DIMENSIONS_OUT_OF_RANGE,
        `image is ${width}x${height}, below ${options.minWidth}x${options.minHeight}`,
      );
    }

    const outputs: ProcessedOutput[] = [];
    for (const output of options.outputs) {
      try {
        const { data, info } = await open()
          .rotate()
          .resize({ width: output.width, withoutEnlargement: true })
          .webp({ quality: options.webpQuality })
          .toBuffer({ resolveWithObject: true });
        outputs.push({ name: output.name, width: info.width, height: info.height, data });
      } catch (error) {
        throw this.rejection(error);
      }
    }
    const largest = outputs.reduce((max, next) => (next.width > max.width ? next : max));
    return { width: largest.width, height: largest.height, outputs };
  }

  private rejection(error: unknown): ImageRejectedError {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /pixel limit/i.test(message)
      ? ImageRejection.DIMENSIONS_OUT_OF_RANGE
      : ImageRejection.DECODE_FAILED;
    return new ImageRejectedError(reason, message, { cause: error });
  }
}

function orientedSize(metadata: sharp.Metadata): { width: number; height: number } {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  return SWAPPING_ORIENTATIONS.has(metadata.orientation ?? 1)
    ? { width: height, height: width }
    : { width, height };
}
