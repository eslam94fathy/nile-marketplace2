import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { type IObjectStorage } from '../../../pkg/storage';
import { type ImageSize, MediaVisibility } from '../enums';
import { type MediaObject } from '../model/media-object.model';
import { IMAGE_SIZES, processedKey, visibilityOf } from './storage-keys';

/** The shared image shape (spec 14 §2, conventions §9.1). */
export interface ImageView {
  id: string;
  urls: Record<ImageSize, string>;
  width: number;
  height: number;
}

type UrlEnv = Pick<Env, 'MEDIA_PUBLIC_BASE_URL' | 'MEDIA_PRIVATE_URL_TTL_SECONDS'>;

/**
 * Image URLs (api): public images through the CDN, private ones through short-lived presigned GETs
 * (ME-1). Responses carry URLs only, never bucket names or keys (spec 14 §1.1).
 */
@injectable()
export class MediaUrls {
  constructor(
    @inject(TOKENS.ObjectStorage) private readonly storage: IObjectStorage,
    @inject(TOKENS.Env) private readonly env: UrlEnv,
  ) {}

  /** `null` unless the media is ready. Private images: the caller has authorised the viewer. */
  async imageOf(media: MediaObject): Promise<ImageView | null> {
    if (media.width === null || media.height === null) return null;
    const entries = await Promise.all(
      IMAGE_SIZES.map(async (size) => [size, await this.url(media, size)] as const),
    );
    return {
      id: media.id,
      urls: Object.fromEntries(entries) as Record<ImageSize, string>,
      width: media.width,
      height: media.height,
    };
  }

  private url(media: MediaObject, size: ImageSize): Promise<string> {
    const key = processedKey(media.id, media.purpose, size);
    if (visibilityOf(media.purpose) === MediaVisibility.PUBLIC) {
      return Promise.resolve(`${this.env.MEDIA_PUBLIC_BASE_URL}/${key}`);
    }
    // Signing is local: no call to storage.
    return this.storage.presignGet(key, this.env.MEDIA_PRIVATE_URL_TTL_SECONDS);
  }
}
