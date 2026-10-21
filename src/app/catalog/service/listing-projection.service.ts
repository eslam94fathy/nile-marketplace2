import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type RatingProjection } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { type ISellerDirectory, SellerStatus } from '../../sellers';
import { type ProductVariantRepository } from '../repository/product-variant.repository';
import { type ProductRepository } from '../repository/product.repository';
import { type ProductProjectionService } from './product-projection.service';

/**
 * The `catalog.listing-projections` consumer's work (spec 06 UC-CA-7), inside the host's
 * transaction (architecture §3.2). Both handlers re-read the current state instead of trusting
 * the payload, so replays and out-of-order events are harmless.
 *
 * No cache to delete: the cached product detail holds neither visibility nor stock (the product
 * row and stock are read fresh on every request), which is all these events change (spec 06 CA-8).
 */
@injectable()
export class ListingProjectionService {
  constructor(
    @inject(TOKENS.ProductRepository) private readonly products: ProductRepository,
    @inject(TOKENS.ProductVariantRepository) private readonly variants: ProductVariantRepository,
    @inject(TOKENS.ProductProjectionService) private readonly projections: ProductProjectionService,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  /** `seller.approved` / `seller.suspended`: `seller_active = (current status = approved)`. */
  async syncSeller(sellerId: string, trx: DbTransaction): Promise<void> {
    const [seller] = await this.sellers.getStatuses([sellerId]);
    if (!seller) {
      this.logger.warn('seller event for an unknown seller, skipped', { sellerId });
      return;
    }
    const active = seller.status === SellerStatus.APPROVED;
    const changed = await this.products.setSellerActive(sellerId, active, trx);
    this.logger.info('seller listing projection applied', {
      sellerId,
      sellerActive: active,
      products: changed,
    });
  }

  /** `inventory.stock_status_changed`: recompute `in_stock` of the variant's product from current stock. */
  async syncStock(variantId: string, trx: DbTransaction): Promise<void> {
    const productId = await this.variants.findProductIdOf(variantId, trx);
    const product = productId ? await this.products.findLiveById(productId, trx, { forUpdate: true }) : null;
    if (!product) {
      // Deleted product (or a variant this database doesn't know): nothing to project.
      this.logger.debug('stock event for a deleted product, skipped', { variantId });
      return;
    }
    await this.projections.recompute(product, trx);
  }

  /**
   * `review.rating_changed` (spec 06 §9.2): the product's rating, newer versions only. The rating sits on
   * the product row, read fresh on every request, so no cache is deleted (CA-8 holds).
   */
  async syncRating(productId: string, rating: RatingProjection, trx: DbTransaction): Promise<void> {
    const applied = await this.products.applyRating(productId, rating, trx);
    if (!applied)
      this.logger.debug('product rating not newer, skipped', { productId, version: rating.version });
  }
}
