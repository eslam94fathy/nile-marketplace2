import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { Money } from '../../../lib/money';
import { type ICatalogDirectory } from '../../catalog';
import { type IInventoryService } from '../../inventory';
import { type MediaService } from '../../media';
import { type IPromotions } from '../../promotions';
import { type ISellerDirectory } from '../../sellers';
import { cartEmpty } from '../errors';
import { type CartItem } from '../model/cart-item.model';
import { assembleCartView, type CartView, emptyCartView } from '../model/cart-view.model';

/** `CouponQuoteDto` (spec 19 §4) before serialisation. */
export interface CouponPreview {
  code: string;
  discountTotal: Money;
  /** The sellers whose lines share the discount, in cart group order. */
  sellerOrders: { sellerId: string; discount: Money }[];
  /** Every line the quote saw, in cart order. */
  lines: { variantId: string; discount: Money }[];
  itemsTotalAfterDiscount: Money;
}
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
    @inject(TOKENS.Promotions) private readonly promotions: IPromotions,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  /** Never creates a cart (CT-8). */
  async get(customerId: string): Promise<CartView> {
    return (await this.load(customerId)).view;
  }

  /**
   * UC-PR-1 (spec 08 §8, spec 19): the coupon against the cart as `GET /cart` shows it, issue lines left
   * out. The lines go to the quote in cart order, as checkout reads them, so the allocation matches.
   * Nothing is stored (PR-1).
   */
  async couponPreview(customerId: string, code: string): Promise<CouponPreview> {
    const { view, items } = await this.load(customerId);
    const order = new Map(items.map((item, index) => [item.id, index]));
    const lines = view.sellers
      .flatMap((group) => group.items.map((line) => ({ line, sellerId: group.sellerId })))
      .filter(({ line }) => line.issue === null)
      .sort((a, b) => (order.get(a.line.id) ?? 0) - (order.get(b.line.id) ?? 0));
    if (lines.length === 0) throw cartEmpty();
    const quote = await this.promotions.quote(
      code,
      customerId,
      lines.map(({ line, sellerId }) => ({
        variantId: line.variantId,
        productId: line.productId,
        sellerId,
        categoryId: line.categoryId,
        lineTotal: line.lineTotal,
      })),
    );
    const sellerOf = new Map(lines.map(({ line, sellerId }) => [line.variantId, sellerId]));
    const bySeller = new Map<string, Money>();
    for (const share of quote.lines) {
      const sellerId = sellerOf.get(share.variantId);
      if (sellerId === undefined) continue;
      bySeller.set(sellerId, (bySeller.get(sellerId) ?? Money.zero()).plus(share.discount));
    }
    return {
      code: quote.code,
      discountTotal: quote.discountTotal,
      sellerOrders: view.sellers
        .filter((group) => bySeller.has(group.sellerId))
        .map((group) => ({
          sellerId: group.sellerId,
          discount: bySeller.get(group.sellerId) ?? Money.zero(),
        })),
      lines: quote.lines,
      itemsTotalAfterDiscount: view.itemsTotal.minus(quote.discountTotal),
    };
  }

  private async load(customerId: string): Promise<{ view: CartView; items: CartItem[] }> {
    const cartId = await this.carts.findIdByCustomerId(customerId);
    if (cartId === null) return { view: emptyCartView(null), items: [] };
    const items = await this.items.listByCartId(cartId);
    if (items.length === 0) return { view: emptyCartView(cartId), items };

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
    return { view, items };
  }
}
