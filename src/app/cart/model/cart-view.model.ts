import { Money } from '../../../lib/money';
import { type PurchasableVariant } from '../../catalog';
import { type StockDto } from '../../inventory';
import { type ImageView } from '../../media';
import { CART_MAX_LINE_QUANTITY } from '../constants';
import { CartItemIssue } from '../enums';
import { type CartItem } from './cart-item.model';

/** One line as the customer sees it (spec 08 §4 `CartItemDto`). */
export interface CartLineView {
  id: string;
  variantId: string;
  productId: string;
  productName: string;
  productSlug: string;
  sku: string;
  attributes: { attribute: string; value: string }[];
  unitPrice: Money;
  quantity: number;
  lineTotal: Money;
  issue: CartItemIssue | null;
  availableQuantity: number;
  /** The variant's image (spec 08 §8); null when it has none. */
  image: ImageView | null;
}

export interface CartSellerGroupView {
  sellerId: string;
  businessName: string;
  items: CartLineView[];
  subtotal: Money;
}

export interface CartView {
  id: string | null;
  sellers: CartSellerGroupView[];
  itemsTotal: Money;
  itemCount: number;
  hasIssues: boolean;
}

/** What the batched lookups returned, keyed for the in-memory join (G20). */
export interface CartLookups {
  variants: ReadonlyMap<string, PurchasableVariant>;
  stock: ReadonlyMap<string, StockDto>;
  businessNames: ReadonlyMap<string, string>;
  /** By media id. */
  images: ReadonlyMap<string, ImageView>;
}

export const emptyCartView = (id: string | null): CartView => ({
  id,
  sellers: [],
  itemsTotal: Money.zero(),
  itemCount: 0,
  hasIssues: false,
});

/** Checked in this order (spec 08 UC-CT-1). A variant without a stock row counts as sellable 0. */
export function classifyIssue(
  purchasable: boolean,
  sellable: number,
  quantity: number,
): CartItemIssue | null {
  if (!purchasable) return CartItemIssue.UNAVAILABLE;
  if (sellable <= 0) return CartItemIssue.OUT_OF_STOCK;
  if (sellable < quantity) return CartItemIssue.INSUFFICIENT_STOCK;
  return null;
}

/** 0 when unavailable, else min(sellable, 99) (CT-6). */
export function availableQuantityOf(issue: CartItemIssue | null, sellable: number): number {
  if (issue === CartItemIssue.UNAVAILABLE) return 0;
  return Math.max(0, Math.min(sellable, CART_MAX_LINE_QUANTITY));
}

/**
 * Joins the lines (in cart order) with the live lookups and groups them by seller. Groups sort by
 * their earliest line; issue lines are shown but left out of every total (CT-6). Lines whose variant
 * or seller the lookups don't know are returned in `orphans` for the caller to log (CT-8).
 */
export function assembleCartView(
  cartId: string,
  items: readonly CartItem[],
  lookups: CartLookups,
): { view: CartView; orphans: CartItem[] } {
  const groups = new Map<string, CartSellerGroupView>();
  const orphans: CartItem[] = [];

  for (const item of items) {
    const variant = lookups.variants.get(item.variantId);
    const businessName = variant ? lookups.businessNames.get(variant.sellerId) : undefined;
    if (!variant || businessName === undefined) {
      orphans.push(item);
      continue;
    }
    const sellable = lookups.stock.get(item.variantId)?.sellable ?? 0;
    const issue = classifyIssue(variant.purchasable, sellable, item.quantity);
    const unitPrice = Money.of(variant.price);
    const line: CartLineView = {
      id: item.id,
      variantId: item.variantId,
      productId: variant.productId,
      productName: variant.productName,
      productSlug: variant.productSlug,
      sku: variant.sku,
      attributes: variant.attributes,
      unitPrice,
      quantity: item.quantity,
      lineTotal: unitPrice.timesQuantity(item.quantity),
      issue,
      availableQuantity: availableQuantityOf(issue, sellable),
      image: variant.imageMediaId === null ? null : (lookups.images.get(variant.imageMediaId) ?? null),
    };
    let group = groups.get(variant.sellerId);
    if (!group) {
      group = { sellerId: variant.sellerId, businessName, items: [], subtotal: Money.zero() };
      groups.set(variant.sellerId, group);
    }
    group.items.push(line);
    if (issue === null) group.subtotal = group.subtotal.plus(line.lineTotal);
  }

  const sellers = [...groups.values()];
  const lines = sellers.flatMap((group) => group.items);
  const view: CartView = {
    id: cartId,
    sellers,
    itemsTotal: Money.sum(sellers.map((group) => group.subtotal)),
    itemCount: lines.filter((line) => line.issue === null).reduce((sum, line) => sum + line.quantity, 0),
    hasIssues: lines.some((line) => line.issue !== null),
  };
  return { view, orphans };
}
