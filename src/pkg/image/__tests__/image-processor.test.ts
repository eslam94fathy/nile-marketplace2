import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  detectImageType,
  ImageContentType,
  ImageRejectedError,
  ImageRejection,
  MAGIC_BYTES_LENGTH,
  type ProcessImageOptions,
  SharpImageProcessor,
  WEBP_MAX_DIMENSION,
} from '..';

const OPTIONS: ProcessImageOptions = {
  outputs: [
    { name: 'thumb', width: 100 },
    { name: 'large', width: 400 },
  ],
  minWidth: 200,
  minHeight: 200,
  maxPixels: 1_000_000,
  webpQuality: 80,
};

/** EXIF tag 0x8825 (GPSInfo IFD pointer), little-endian as sharp writes it. */
const GPS_IFD_TAG = Buffer.from([0x25, 0x88]);

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } });

async function rejection(input: Buffer, options = OPTIONS): Promise<ImageRejectedError> {
  const error: unknown = await new SharpImageProcessor().process(input, options).then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ImageRejectedError)) throw new Error('expected an ImageRejectedError');
  return error;
}

/* Spec 14 UC-ME-3: fixed WebP sizes, no metadata, permanent failures for unusable images. */
describe('SharpImageProcessor', () => {
  it('writes each size as WebP, keeps the aspect ratio and never upscales', async () => {
    const input = await solid(300, 600).jpeg().toBuffer();
    const result = await new SharpImageProcessor().process(input, OPTIONS);

    expect(result.outputs.map(({ name, width, height }) => ({ name, width, height }))).toEqual([
      { name: 'thumb', width: 100, height: 200 },
      // 300 px wide: the 400 px size stays at 300.
      { name: 'large', width: 300, height: 600 },
    ]);
    expect({ width: result.width, height: result.height }).toEqual({ width: 300, height: 600 });
    for (const output of result.outputs) {
      expect((await sharp(output.data).metadata()).format).toBe('webp');
    }
  });

  it('strips EXIF (GPS included) and applies the EXIF orientation', async () => {
    const input = await solid(400, 200)
      .jpeg()
      .withExif({
        IFD0: { Make: 'PhoneCo' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '30/1 2/1 0/1',
          GPSLongitudeRef: 'E',
          GPSLongitude: '31/1 14/1 0/1',
        },
      })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const before = await sharp(input).metadata();
    expect(before.exif?.includes(Buffer.from('PhoneCo'))).toBe(true);
    expect(before.exif?.includes(GPS_IFD_TAG)).toBe(true);
    expect(before.orientation).toBe(6);

    const result = await new SharpImageProcessor().process(input, OPTIONS);

    // Orientation 6 rotates 90°: the 400 x 200 landscape becomes a 200 x 400 portrait.
    expect({ width: result.width, height: result.height }).toEqual({ width: 200, height: 400 });
    for (const output of result.outputs) {
      const after = await sharp(output.data).metadata();
      expect(after.exif).toBeUndefined();
      expect(after.xmp).toBeUndefined();
      expect(after.orientation).toBeUndefined();
      expect(output.data.includes(Buffer.from('PhoneCo'))).toBe(false);
    }
  });

  it('an image under the minimum size → dimensions_out_of_range', async () => {
    const error = await rejection(await solid(199, 800).png().toBuffer());
    expect(error.reason).toBe(ImageRejection.DIMENSIONS_OUT_OF_RANGE);
  });

  it('a decompression bomb (more pixels than allowed) is refused before decoding → dimensions_out_of_range', async () => {
    // 2000 x 2000 of one colour: a tiny file, 4 MP once decoded.
    const bomb = await solid(2000, 2000).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(100_000);
    const error = await rejection(bomb);
    expect(error.reason).toBe(ImageRejection.DIMENSIONS_OUT_OF_RANGE);
  });

  it('an output taller than WebP can encode → dimensions_out_of_range, before encoding', async () => {
    // 200 x 20000 = 4 MP: under the pixel limit, but every output stays 20000 px tall.
    const tall = await solid(200, 20_000).png({ compressionLevel: 9 }).toBuffer();
    const error = await rejection(tall, { ...OPTIONS, maxPixels: 5_000_000 });
    expect(error.reason).toBe(ImageRejection.DIMENSIONS_OUT_OF_RANGE);
    expect(error.message).toContain(String(WEBP_MAX_DIMENSION));
  });

  it('corrupt or truncated bytes → decode_failed', async () => {
    const jpeg = await solid(400, 400).jpeg().toBuffer();
    expect((await rejection(jpeg.subarray(0, jpeg.length / 2))).reason).toBe(ImageRejection.DECODE_FAILED);
    expect((await rejection(Buffer.from('not an image at all'))).reason).toBe(ImageRejection.DECODE_FAILED);
  });
});

describe('detectImageType', () => {
  it('reads JPEG, PNG and WebP signatures from the leading bytes', async () => {
    const image = solid(8, 8);
    const head = async (buffer: Promise<Buffer>) => (await buffer).subarray(0, MAGIC_BYTES_LENGTH);
    expect(detectImageType(await head(image.clone().jpeg().toBuffer()))).toBe(ImageContentType.JPEG);
    expect(detectImageType(await head(image.clone().png().toBuffer()))).toBe(ImageContentType.PNG);
    expect(detectImageType(await head(image.clone().webp().toBuffer()))).toBe(ImageContentType.WEBP);
  });

  it('anything else, or too few bytes → null', async () => {
    const gif = await solid(8, 8).gif().toBuffer();
    expect(detectImageType(gif.subarray(0, MAGIC_BYTES_LENGTH))).toBeNull();
    expect(detectImageType(Buffer.from('RIFF....AVI '))).toBeNull();
    expect(detectImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
  });
});
