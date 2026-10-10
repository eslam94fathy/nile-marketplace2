import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IInventoryService } from '../../inventory';
import { computeProjection, type ProductProjection } from '../model/product-projection';
import { type Product } from '../model/product.model';
import { type ProductVariantRepository } from '../repository/product-variant.repository';
import { type ProductRepository } from '../repository/product.repository';

/**
 * Recomputes min/max price, in_stock and the "no active variant → inactive" rule of a product, in
 * the caller's transaction. The caller holds the product row lock (spec 06 CA-2).
 */
@injectable()
export class ProductProjectionService {
  constructor(
    @inject(TOKENS.ProductRepository) private readonly products: ProductRepository,
    @inject(TOKENS.ProductVariantRepository) private readonly variants: ProductVariantRepository,
    @inject(TOKENS.InventoryService) private readonly inventory: IInventoryService,
  ) {}

  async recompute(product: Product, trx: DbTransaction): Promise<ProductProjection> {
    const live = await this.variants.findLiveByProductIds([product.id], trx);
    const activeIds = live.filter((variant) => variant.isActive).map((variant) => variant.id);
    const stock = await this.inventory.getStockByVariantIds(activeIds, trx);
    const projection = computeProjection(
      product.status,
      live,
      new Map(stock.map((s) => [s.variantId, s.sellable])),
    );
    await this.products.applyProjection(product.id, projection, trx);
    return projection;
  }
}
