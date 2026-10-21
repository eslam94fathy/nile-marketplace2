import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ProductCard } from '../model/product-card.model';
import { type PurchasableVariant } from '../model/purchasable-variant.model';
import { type ProductVariantRepository } from '../repository/product-variant.repository';
import { type ProductRepository } from '../repository/product.repository';
import { type ProductImageViewService } from './product-image-view.service';

/** Public API of catalog (spec 06 §2, §9.3). */
export interface ICatalogDirectory {
  /** One query. Unknown ids are left out; hidden or deleted ones come back with `purchasable: false`. */
  getVariantsForPurchase(variantIds: readonly string[], trx?: DbTransaction): Promise<PurchasableVariant[]>;
  /**
   * Batched: one product read and one primary-image read (customers' wishlist, reviews' lists). Deleted
   * and hidden products come back too, with `available: false`. Unknown ids are left out.
   */
  getProductCards(productIds: readonly string[]): Promise<Map<string, ProductCard>>;
  /** The public visibility rule (VIS) as an EXISTS (G22): reviews' PRODUCT_NOT_FOUND. */
  isPubliclyVisible(productId: string): Promise<boolean>;
}

@injectable()
export class CatalogDirectory implements ICatalogDirectory {
  constructor(
    @inject(TOKENS.ProductVariantRepository) private readonly variants: ProductVariantRepository,
    @inject(TOKENS.ProductRepository) private readonly products: ProductRepository,
    @inject(TOKENS.ProductImageViewService) private readonly images: ProductImageViewService,
  ) {}

  getVariantsForPurchase(variantIds: readonly string[], trx?: DbTransaction): Promise<PurchasableVariant[]> {
    return this.variants.findForPurchase(variantIds, trx);
  }

  async getProductCards(productIds: readonly string[]): Promise<Map<string, ProductCard>> {
    if (productIds.length === 0) return new Map();
    const products = await this.products.findByIds(productIds);
    const primaries = await this.images.primaryFor(products.map((p) => p.id));
    return new Map(
      products.map((product) => [
        product.id,
        {
          id: product.id,
          slug: product.slug,
          name: product.name,
          minPrice: product.minPrice?.toString() ?? null,
          maxPrice: product.maxPrice?.toString() ?? null,
          inStock: product.inStock,
          available: product.visible,
          primaryImage: primaries.get(product.id) ?? null,
          rating: { avg: product.ratingAvg, count: product.ratingCount },
        },
      ]),
    );
  }

  isPubliclyVisible(productId: string): Promise<boolean> {
    return this.products.existsVisible(productId);
  }
}
