import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { type ICache } from '../../../pkg/cache';
import { productDetailCacheKey } from '../constants';
import { type ProductImageView } from '../model/product-image.model';

type CacheEnv = Pick<Env, 'PRODUCT_DETAIL_CACHE_TTL_SECONDS'>;

/**
 * The static part of a public product detail: everything except the product row itself (read
 * fresh, so visibility and prices are never stale) and stock (read live, spec 06 §4.1).
 */
export interface ProductDetailStatic {
  category: { id: string; name: string; slug: string; path: { id: string; name: string; slug: string }[] };
  seller: { id: string; businessName: string };
  /** Attributes in category order, with only the options active variants use. */
  attributes: { code: string; name: string; options: { code: string; value: string }[] }[];
  /** Active variants, oldest first. */
  variants: {
    id: string;
    sku: string;
    price: string;
    compareAtPrice: string | null;
    options: { attributeCode: string; optionCode: string; value: string }[];
    /** The media id within `images` shown for this variant (spec 06 §8.1). */
    imageId: string | null;
  }[];
  /** In position order. CDN URLs never change, so caching them is safe (spec 06 §8.5). */
  images: ProductImageView[];
}

/**
 * `v1:catalog:product:<id>`, cache-aside with a short TTL (spec 06 CA-8). Deleted after commit by
 * every product/variant write and by the listing-projection consumers. Redis failures degrade to
 * the DB with a `warn`.
 */
@injectable()
export class ProductDetailCache {
  constructor(
    @inject(TOKENS.Cache) private readonly cache: ICache,
    @inject(TOKENS.Env) private readonly env: CacheEnv,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  async get(productId: string): Promise<ProductDetailStatic | undefined> {
    const key = productDetailCacheKey(productId);
    try {
      const raw = await this.cache.get(key);
      if (raw === null) return undefined;
      const parsed = JSON.parse(raw) as Partial<ProductDetailStatic> | null;
      // An entry from before images (R2) has no `images`: a miss, rebuilt once.
      if (
        !Array.isArray(parsed?.variants) ||
        !Array.isArray(parsed.attributes) ||
        !Array.isArray(parsed.images) ||
        !parsed.category
      ) {
        throw new TypeError('cached product detail has an unexpected shape');
      }
      return parsed as ProductDetailStatic;
    } catch (error) {
      this.logger.warn('product detail cache read failed, reading the database', { key, error });
      return undefined;
    }
  }

  async set(productId: string, detail: ProductDetailStatic): Promise<void> {
    const key = productDetailCacheKey(productId);
    try {
      await this.cache.set(key, JSON.stringify(detail), this.env.PRODUCT_DETAIL_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn('product detail cache write failed', { key, error });
    }
  }

  /** After commit. A failed delete is bounded by the TTL. */
  async invalidate(productIds: readonly string[]): Promise<void> {
    if (productIds.length === 0) return;
    const keys = productIds.map(productDetailCacheKey);
    try {
      await this.cache.delete(...keys);
    } catch (error) {
      this.logger.warn('product detail cache invalidation failed; stale until the TTL expires', {
        keys: keys.length,
        error,
      });
    }
  }
}
