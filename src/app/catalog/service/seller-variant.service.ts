import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery } from '../../../lib/http';
import { type Money } from '../../../lib/money';
import { type IInventoryService, type InventoryMovement, type StockDto } from '../../inventory';
import { MAX_VARIANTS_PER_PRODUCT } from '../constants';
import { type VariantStatus } from '../enums';
import {
  compareAtPriceInvalid,
  defaultVariantExists,
  productNotFound,
  variantLimitReached,
  variantNotFound,
  variantOptionsInvalid,
} from '../errors';
import { type CategoryAttribute } from '../model/category-tree.model';
import { type Product } from '../model/product.model';
import { resolveVariantOptions } from '../model/variant-options';
import { type CategoryAttributeOptionRepository } from '../repository/category-attribute-option.repository';
import { type CategoryAttributeRepository } from '../repository/category-attribute.repository';
import { type ProductVariantRepository } from '../repository/product-variant.repository';
import { type ProductRepository } from '../repository/product.repository';
import { type VariantAttributeValueRepository } from '../repository/variant-attribute-value.repository';
import { type CategoryTreeService } from './category-tree.service';
import { type ProductDetailCache } from './product-detail-cache.service';
import { type ProductProjectionService } from './product-projection.service';
import { type SellerGuard } from './seller-guard.service';
import { type VariantView, type VariantViewService } from './variant-view.service';

export interface CreateVariantInput {
  sku: string;
  price: Money;
  compareAtPrice: Money | null;
  optionIds: string[];
  initialStock: number;
  status: VariantStatus;
}

export interface UpdateVariantInput {
  sku?: string;
  price?: Money;
  compareAtPrice?: Money | null;
  status?: VariantStatus;
}

/**
 * Seller variants and stock (spec 06 UC-CA-4, UC-CA-5). Variant writes lock the product row, then
 * recompute its projections in the same transaction (spec 06 CA-2, CA-9). Stock adjustments don't
 * lock the product: `in_stock` follows through inventory's event (UC-CA-7).
 */
@injectable()
export class SellerVariantService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.SellerGuard) private readonly guard: SellerGuard,
    @inject(TOKENS.ProductRepository) private readonly products: ProductRepository,
    @inject(TOKENS.ProductVariantRepository) private readonly variants: ProductVariantRepository,
    @inject(TOKENS.CategoryAttributeRepository) private readonly attributes: CategoryAttributeRepository,
    @inject(TOKENS.CategoryAttributeOptionRepository)
    private readonly options: CategoryAttributeOptionRepository,
    @inject(TOKENS.VariantAttributeValueRepository)
    private readonly values: VariantAttributeValueRepository,
    @inject(TOKENS.CategoryTreeService) private readonly trees: CategoryTreeService,
    @inject(TOKENS.ProductProjectionService) private readonly projections: ProductProjectionService,
    @inject(TOKENS.InventoryService) private readonly inventory: IInventoryService,
    @inject(TOKENS.VariantViewService) private readonly views: VariantViewService,
    @inject(TOKENS.ProductDetailCache) private readonly detailCache: ProductDetailCache,
  ) {}

  async create(userId: string, productId: string, input: CreateVariantInput): Promise<VariantView> {
    assertCompareAtPrice(input.price, input.compareAtPrice);
    const view = await this.tx.run(async (trx) => {
      const product = await this.lockProduct(userId, productId, trx);
      const live = await this.variants.findLiveByProductIds([product.id], trx);
      if (live.length >= MAX_VARIANTS_PER_PRODUCT) throw variantLimitReached(MAX_VARIANTS_PER_PRODUCT);

      const effective = await this.effectiveAttributes(product.categoryId, trx);
      const resolved = resolveVariantOptions(
        effective,
        input.optionIds,
        await this.options.findByIds(input.optionIds, trx),
      );
      if (Array.isArray(resolved)) throw variantOptionsInvalid(resolved);
      const isDefault = effective.length === 0;
      if (isDefault && live.length > 0) throw defaultVariantExists();

      const variant = await this.variants.insert(
        {
          productId: product.id,
          sellerId: product.sellerId,
          sku: input.sku,
          price: input.price,
          compareAtPrice: input.compareAtPrice,
          status: input.status,
          optionSignature: resolved.signature,
          isDefault,
        },
        trx,
      );
      await this.values.insertMany(variant.id, resolved.values, trx);
      await this.inventory.createItem(variant.id, input.initialStock, userId, trx);
      await this.projections.recompute(product, trx);
      return this.view(variant.id, product.sellerId, trx);
    });
    await this.detailCache.invalidate([productId]);
    return view;
  }

  async update(
    userId: string,
    productId: string,
    variantId: string,
    input: UpdateVariantInput,
  ): Promise<VariantView> {
    const view = await this.tx.run(async (trx) => {
      const product = await this.lockProduct(userId, productId, trx);
      const variant = await this.liveVariantOf(product, variantId, trx);
      assertCompareAtPrice(
        input.price ?? variant.price,
        input.compareAtPrice === undefined ? variant.compareAtPrice : input.compareAtPrice,
      );
      await this.variants.update(variant.id, input, trx);
      await this.projections.recompute(product, trx);
      return this.view(variant.id, product.sellerId, trx);
    });
    await this.detailCache.invalidate([productId]);
    return view;
  }

  async delete(userId: string, productId: string, variantId: string): Promise<void> {
    await this.tx.run(async (trx) => {
      const product = await this.lockProduct(userId, productId, trx);
      const variant = await this.liveVariantOf(product, variantId, trx);
      await this.variants.softDelete(variant.id, trx);
      await this.projections.recompute(product, trx);
    });
    await this.detailCache.invalidate([productId]);
  }

  /** A delta, never an absolute value (S-6). */
  async adjustStock(userId: string, variantId: string, delta: number): Promise<StockDto> {
    return this.tx.run(async (trx) => {
      const sellerId = await this.guard.approvedSellerId(userId, trx);
      if (!(await this.variants.findLiveForSeller(variantId, sellerId, trx))) throw variantNotFound();
      return this.inventory.adjust(variantId, delta, userId, trx);
    });
  }

  /** Any seller status (spec 06 CA-12 b). */
  async listMovements(
    userId: string,
    variantId: string,
    query: ParsedListQuery,
  ): Promise<{ items: InventoryMovement[]; meta: PageMeta }> {
    const sellerId = await this.guard.sellerId(userId);
    if (!(await this.variants.findLiveForSeller(variantId, sellerId))) throw variantNotFound();
    return this.inventory.listMovements(variantId, query);
  }

  private async lockProduct(userId: string, productId: string, trx: DbTransaction): Promise<Product> {
    const sellerId = await this.guard.approvedSellerId(userId, trx);
    const product = await this.products.findLiveForSeller(productId, sellerId, trx, { forUpdate: true });
    if (!product) throw productNotFound();
    return product;
  }

  private async liveVariantOf(product: Product, variantId: string, trx: DbTransaction) {
    const variant = await this.variants.findLiveForSeller(variantId, product.sellerId, trx);
    if (variant?.productId !== product.id) throw variantNotFound();
    return variant;
  }

  /**
   * Own + inherited attributes of the category, ancestors first (Q-30). The path comes from the
   * cached tree (a category never moves); the attributes are read fresh in the transaction.
   */
  private async effectiveAttributes(categoryId: string, trx: DbTransaction): Promise<CategoryAttribute[]> {
    const path = (await this.trees.getTree()).path(categoryId).map((category) => category.id);
    const depthOf = new Map(path.map((id, index) => [id, index]));
    return (await this.attributes.findByCategoryIds(path, trx)).sort(
      (a, b) =>
        (depthOf.get(a.categoryId) ?? 0) - (depthOf.get(b.categoryId) ?? 0) ||
        a.sortOrder - b.sortOrder ||
        a.code.localeCompare(b.code),
    );
  }

  private async view(variantId: string, sellerId: string, trx: DbTransaction): Promise<VariantView> {
    const variant = await this.variants.findLiveForSeller(variantId, sellerId, trx);
    if (!variant) throw variantNotFound();
    const [view] = await this.views.build([variant], trx);
    if (!view) throw variantNotFound();
    return view;
  }
}

function assertCompareAtPrice(price: Money, compareAtPrice: Money | null): void {
  if (compareAtPrice !== null && !compareAtPrice.greaterThan(price)) throw compareAtPriceInvalid();
}
