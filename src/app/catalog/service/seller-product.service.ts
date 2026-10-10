import { randomInt } from 'node:crypto';
import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { slugify } from '../../../pkg/text';
import { PRODUCT_SLUG_FALLBACK, PRODUCT_SLUG_MAX_LENGTH, PRODUCT_SLUG_SUFFIX_LENGTH } from '../constants';
import { ProductStatus } from '../enums';
import {
  categoryReferenceNotFound,
  productCategoryLocked,
  productHasNoActiveVariant,
  productInvalidStatusTransition,
  productNotFound,
} from '../errors';
import { type Product } from '../model/product.model';
import { type CategoryRepository } from '../repository/category.repository';
import { type ProductVariantRepository } from '../repository/product-variant.repository';
import { type ProductRepository } from '../repository/product.repository';
import { type ProductDetailCache } from './product-detail-cache.service';
import { type SellerGuard } from './seller-guard.service';
import { type VariantView, type VariantViewService } from './variant-view.service';

export interface ProductDetail {
  product: Product;
  variants: VariantView[];
}

export interface CreateProductInput {
  categoryId: string;
  name: string;
  description: string;
}
export type UpdateProductInput = Partial<CreateProductInput>;

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** kebab(name) + "-" + 6 random base36 chars; immutable, so links survive renames (spec 06 UC-CA-3). */
export function productSlug(name: string, random: (max: number) => number = randomInt): string {
  const base =
    slugify(name, PRODUCT_SLUG_MAX_LENGTH - PRODUCT_SLUG_SUFFIX_LENGTH - 1) || PRODUCT_SLUG_FALLBACK;
  const suffix = Array.from({ length: PRODUCT_SLUG_SUFFIX_LENGTH }, () => BASE36[random(BASE36.length)]).join(
    '',
  );
  return `${base}-${suffix}`;
}

/**
 * Seller products (spec 06 UC-CA-3). Writes: approved seller (read FOR SHARE), product row locked
 * FOR UPDATE, category held FOR SHARE when it is (re)assigned (spec 06 CA-2, CA-3).
 * Reads work in any seller status.
 */
@injectable()
export class SellerProductService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.SellerGuard) private readonly guard: SellerGuard,
    @inject(TOKENS.ProductRepository) private readonly products: ProductRepository,
    @inject(TOKENS.ProductVariantRepository) private readonly variants: ProductVariantRepository,
    @inject(TOKENS.CategoryRepository) private readonly categories: CategoryRepository,
    @inject(TOKENS.VariantViewService) private readonly views: VariantViewService,
    @inject(TOKENS.ProductDetailCache) private readonly detailCache: ProductDetailCache,
  ) {}

  async list(userId: string, query: ParsedListQuery): Promise<{ items: Product[]; meta: PageMeta }> {
    const sellerId = await this.guard.sellerId(userId);
    return toPage(await this.products.listForSeller(sellerId, query), query, (p) => p.createdAt);
  }

  async get(userId: string, productId: string): Promise<ProductDetail> {
    const sellerId = await this.guard.sellerId(userId);
    return this.detail(productId, sellerId);
  }

  async create(userId: string, input: CreateProductInput): Promise<ProductDetail> {
    const product = await this.tx.run(async (trx) => {
      const sellerId = await this.guard.approvedSellerId(userId, trx);
      await this.holdActiveCategory(input.categoryId, trx);
      return this.products.insert(
        {
          sellerId,
          categoryId: input.categoryId,
          name: input.name,
          slug: productSlug(input.name),
          description: input.description,
          status: ProductStatus.DRAFT,
          // The guard just read the seller as approved, under a share lock.
          sellerActive: true,
          inStock: false,
        },
        trx,
      );
    });
    return { product, variants: [] };
  }

  async update(userId: string, productId: string, input: UpdateProductInput): Promise<ProductDetail> {
    const sellerId = await this.write(userId, productId, async (product, trx) => {
      if (input.categoryId !== undefined && input.categoryId !== product.categoryId) {
        if ((await this.variants.findLiveByProductIds([product.id], trx)).length > 0) {
          throw productCategoryLocked();
        }
        await this.holdActiveCategory(input.categoryId, trx);
      }
      await this.products.update(product.id, input, trx);
    });
    return this.detail(productId, sellerId);
  }

  async activate(userId: string, productId: string): Promise<ProductDetail> {
    const sellerId = await this.write(userId, productId, async (product, trx) => {
      if (!product.canTransitionTo(ProductStatus.ACTIVE)) throw productInvalidStatusTransition();
      const live = await this.variants.findLiveByProductIds([product.id], trx);
      if (!live.some((variant) => variant.isActive)) throw productHasNoActiveVariant();
      await this.products.setStatus(product.id, ProductStatus.ACTIVE, true, trx);
    });
    return this.detail(productId, sellerId);
  }

  async deactivate(userId: string, productId: string): Promise<ProductDetail> {
    const sellerId = await this.write(userId, productId, async (product, trx) => {
      if (!product.canTransitionTo(ProductStatus.INACTIVE)) throw productInvalidStatusTransition();
      await this.products.setStatus(product.id, ProductStatus.INACTIVE, false, trx);
    });
    return this.detail(productId, sellerId);
  }

  /** Soft delete of the product and its variants. Carts show the lines as unavailable; orders keep snapshots. */
  async delete(userId: string, productId: string): Promise<void> {
    await this.write(userId, productId, async (product, trx) => {
      await this.variants.softDeleteByProduct(product.id, trx);
      await this.products.softDelete(product.id, trx);
    });
  }

  /** The product with its live variants, options and stock. */
  async detail(productId: string, sellerId: string, trx?: DbTransaction): Promise<ProductDetail> {
    const product = await this.products.findLiveForSeller(productId, sellerId, trx);
    if (!product) throw productNotFound();
    const variants = await this.variants.findLiveByProductIds([product.id], trx);
    return { product, variants: await this.views.build(variants, trx) };
  }

  /**
   * One write transaction: approved seller, then the seller's live product locked FOR UPDATE.
   * The public detail cache key is deleted after commit.
   */
  private async write(
    userId: string,
    productId: string,
    work: (product: Product, trx: DbTransaction) => Promise<void>,
  ): Promise<string> {
    const sellerId = await this.tx.run(async (trx) => {
      const seller = await this.guard.approvedSellerId(userId, trx);
      const product = await this.products.findLiveForSeller(productId, seller, trx, { forUpdate: true });
      if (!product) throw productNotFound();
      await work(product, trx);
      return seller;
    });
    await this.detailCache.invalidate([productId]);
    return sellerId;
  }

  /** The category must exist and be active (422); held FOR SHARE until commit (spec 06 CA-2). */
  private async holdActiveCategory(categoryId: string, trx: DbTransaction): Promise<void> {
    const category = await this.categories.findForShare(categoryId, trx);
    if (!category?.isActive) throw categoryReferenceNotFound();
  }
}
