import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { type ICatalogDirectory } from '../../catalog';
import { type IInventoryService } from '../../inventory';
import { type MediaService } from '../../media';
import { type ISellerDirectory } from '../../sellers';
import { assembleCartView, type CartView, emptyCartView } from '../model/cart-view.model';
import { CartItemRepository } from '../repository/cart-item.repository';
import { CartRepository } from '../repository/cart.repository';

/**
 * UC-CT-1: the cart with live prices, stock, issues and images. Four batched cross-module lookups,
 * joined in memory (G20). Read without a transaction: it is a view, and checkout re-checks everything.
 */
@injectable()
export class CartViewService {
  constructor(
    @inject(TOKENS.CartRepository) private readonly carts: CartRepository,
    @inject(TOKENS.CartItemRepository) private readonly items: CartItemRepository,
    @inject(TOKENS.CatalogDirectory) private readonly catalog: ICatalogDirectory,
    @inject(TOKENS.InventoryService) private readonly inventory: IInventoryService,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  /** Never creates a cart (CT-8). */
  async get(customerId: string): Promise<CartView> {
    const cartId = await this.carts.findIdByCustomerId(customerId);
    if (cartId === null) return emptyCartView(null);
    const items = await this.items.listByCartId(cartId);
    if (items.length === 0) return emptyCartView(cartId);

    const variantIds = items.map((item) => item.variantId);
    const [variants, stock] = await Promise.all([
      this.catalog.getVariantsForPurchase(variantIds),
      this.inventory.getStockByVariantIds(variantIds),
    ]);
    const sellerIds = [...new Set(variants.map((variant) => variant.sellerId))];
    const mediaIds = variants.flatMap((variant) =>
      variant.imageMediaId === null ? [] : [variant.imageMediaId],
    );
    const [summaries, images] = await Promise.all([
      this.sellers.getSummaries(sellerIds),
      this.media.getImages(mediaIds),
    ]);

    const { view, orphans } = assembleCartView(cartId, items, {
      variants: new Map(variants.map((variant) => [variant.variantId, variant])),
      stock: new Map(stock.map((level) => [level.variantId, level])),
      businessNames: new Map(summaries.map((summary) => [summary.sellerId, summary.businessName])),
      images,
    });
    if (orphans.length > 0) {
      this.logger.error('cart lines without a known variant or seller were left out', {
        module: 'cart',
        cartId,
        cartItemIds: orphans.map((item) => item.id),
      });
    }
    return view;
  }
}
