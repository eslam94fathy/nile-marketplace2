import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { MediaPurpose, type MediaService } from '../../media';
import { PRODUCT_IMAGE_LIMIT } from '../constants';
import {
  productImageLimitReached,
  productImageNotFound,
  productImageOrderInvalid,
  productNotFound,
  variantReferenceNotFound,
} from '../errors';
import { type ProductImage, type ProductImageView } from '../model/product-image.model';
import { type Product } from '../model/product.model';
import { type ProductImageRepository } from '../repository/product-image.repository';
import { type ProductVariantRepository } from '../repository/product-variant.repository';
import { type ProductRepository } from '../repository/product.repository';
import { type ProductDetailCache } from './product-detail-cache.service';
import { type ProductImageViewService } from './product-image-view.service';
import { type SellerGuard } from './seller-guard.service';

export interface AddProductImageInput {
  mediaId: string;
  variantId?: string | null;
  altText?: string | null;
  position?: number;
}

export interface UpdateProductImageInput {
  variantId?: string | null;
  altText?: string | null;
}

/**
 * Seller product images (spec 06 UC-CA-8). Same guard and locks as every product write: the seller
 * read `FOR SHARE` (approved), then the product row `FOR UPDATE`, so the count of 8 and the positions
 * can't race. The public detail cache is deleted after commit.
 */
@injectable()
export class ProductImageService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.SellerGuard) private readonly guard: SellerGuard,
    @inject(TOKENS.ProductRepository) private readonly products: ProductRepository,
    @inject(TOKENS.ProductVariantRepository) private readonly variants: ProductVariantRepository,
    @inject(TOKENS.ProductImageRepository) private readonly images: ProductImageRepository,
    @inject(TOKENS.ProductImageViewService) private readonly views: ProductImageViewService,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
    @inject(TOKENS.ProductDetailCache) private readonly detailCache: ProductDetailCache,
  ) {}

  /** Returns every image of the product, in order. */
  async add(userId: string, productId: string, input: AddProductImageInput): Promise<ProductImageView[]> {
    await this.write(userId, productId, async (product, existing, trx) => {
      if (existing.length >= PRODUCT_IMAGE_LIMIT) throw productImageLimitReached(PRODUCT_IMAGE_LIMIT);
      const variantId = input.variantId ?? null;
      if (variantId !== null) await this.requireVariant(product, variantId, trx);
      await this.media.claim(
        [input.mediaId],
        { purpose: MediaPurpose.PRODUCT_IMAGE, ownerUserId: userId },
        trx,
      );
      await this.images.insertAt(
        {
          productId: product.id,
          mediaId: input.mediaId,
          variantId,
          // A position past the end appends (spec 06 CA-16).
          position: Math.min(input.position ?? existing.length, existing.length),
          altText: input.altText ?? null,
        },
        trx,
      );
    });
    return this.views.forProduct(productId);
  }

  async update(
    userId: string,
    productId: string,
    mediaId: string,
    input: UpdateProductImageInput,
  ): Promise<ProductImageView> {
    await this.write(userId, productId, async (product, existing, trx) => {
      const image = imageOf(existing, mediaId);
      if (input.variantId) await this.requireVariant(product, input.variantId, trx);
      await this.images.update(image.id, input, trx);
    });
    const view = (await this.views.forProduct(productId)).find((candidate) => candidate.image.id === mediaId);
    if (!view) throw productImageNotFound();
    return view;
  }

  /** `mediaIds` must be every image of the product exactly once (the DTO rejects duplicates). */
  async reorder(userId: string, productId: string, mediaIds: readonly string[]): Promise<ProductImageView[]> {
    await this.write(userId, productId, async (product, existing, trx) => {
      const current = new Set(existing.map((image) => image.mediaId));
      if (mediaIds.length !== current.size || !mediaIds.every((id) => current.has(id))) {
        throw productImageOrderInvalid();
      }
      await this.images.reorder(product.id, mediaIds, trx);
    });
    return this.views.forProduct(productId);
  }

  /** The media is released and deleted later by the media cleanup unless an order still shows it. */
  async remove(userId: string, productId: string, mediaId: string): Promise<void> {
    await this.write(userId, productId, async (_product, existing, trx) => {
      const image = imageOf(existing, mediaId);
      await this.images.deleteAndCompact(image, trx);
      await this.media.release([image.mediaId], trx);
    });
  }

  private async write(
    userId: string,
    productId: string,
    work: (product: Product, images: ProductImage[], trx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    await this.tx.run(async (trx) => {
      const sellerId = await this.guard.approvedSellerId(userId, trx);
      const product = await this.products.findLiveForSeller(productId, sellerId, trx, { forUpdate: true });
      if (!product) throw productNotFound();
      await work(product, await this.images.findByProduct(product.id, trx), trx);
    });
    await this.detailCache.invalidate([productId]);
  }

  private async requireVariant(product: Product, variantId: string, trx: DbTransaction): Promise<void> {
    const live = await this.variants.findLiveByProductIds([product.id], trx);
    if (!live.some((variant) => variant.id === variantId)) throw variantReferenceNotFound();
  }
}

function imageOf(images: readonly ProductImage[], mediaId: string): ProductImage {
  const image = images.find((candidate) => candidate.mediaId === mediaId);
  if (!image) throw productImageNotFound();
  return image;
}
