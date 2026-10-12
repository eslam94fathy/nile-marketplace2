import { Money, type Rate } from '../../../lib/money';

/** One cart line priced at checkout, with the snapshot the order line keeps (spec 09 §3.1 step 5–6). */
export interface PricedLine {
  variantId: string;
  productId: string;
  sellerId: string;
  productName: string;
  sku: string;
  attributes: { attribute: string; value: string }[];
  unitPrice: Money;
  quantity: number;
}

export interface SellerSplit {
  sellerId: string;
  lines: (PricedLine & { lineTotal: Money })[];
  subtotal: Money;
  commissionRate: Rate;
  commission: Money;
  sellerNet: Money;
}

export interface CheckoutMoney {
  /** One per seller, in the order each seller first appears in the cart. */
  sellers: SellerSplit[];
  itemsTotal: Money;
  deliveryFee: Money;
  total: Money;
}

/**
 * The money of a checkout (overview §5, spec 09 §3.1 step 5): line totals, the per-seller split with
 * `commission = round(subtotal × rate)` (ROUND_HALF_UP to the piastre) and `net = subtotal − commission`,
 * the items total, the one delivery fee of the checkout, and the total.
 */
export function computeCheckoutMoney(
  lines: readonly PricedLine[],
  commissionRates: ReadonlyMap<string, Rate>,
  deliveryFee: Money,
): CheckoutMoney {
  const bySeller = new Map<string, (PricedLine & { lineTotal: Money })[]>();
  for (const line of lines) {
    const group = bySeller.get(line.sellerId) ?? [];
    group.push({ ...line, lineTotal: line.unitPrice.timesQuantity(line.quantity) });
    bySeller.set(line.sellerId, group);
  }

  const sellers = [...bySeller.entries()].map(([sellerId, sellerLines]): SellerSplit => {
    const commissionRate = commissionRates.get(sellerId);
    if (!commissionRate) throw new Error(`no commission rate for seller ${sellerId}`);
    const subtotal = Money.sum(sellerLines.map((line) => line.lineTotal));
    const commission = subtotal.timesRate(commissionRate);
    return {
      sellerId,
      lines: sellerLines,
      subtotal,
      commissionRate,
      commission,
      sellerNet: subtotal.minus(commission),
    };
  });

  const itemsTotal = Money.sum(sellers.map((seller) => seller.subtotal));
  return { sellers, itemsTotal, deliveryFee, total: itemsTotal.plus(deliveryFee) };
}
