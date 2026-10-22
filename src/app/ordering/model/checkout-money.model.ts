import { Money, type Rate } from '../../../lib/money';
import { CouponFunding } from '../../promotions';

/** One cart line priced at checkout, with the snapshot the order line keeps (spec 09 §3.1 step 5–6). */
export interface PricedLine {
  variantId: string;
  productId: string;
  sellerId: string;
  /** The product's category: the coupon scope (spec 19 PR-11). */
  categoryId: string;
  productName: string;
  sku: string;
  attributes: { attribute: string; value: string }[];
  unitPrice: Money;
  quantity: number;
  imageMediaId: string | null;
}

/** The checkout's coupon as the quote gave it (spec 19 §2). */
export interface CheckoutDiscount {
  funding: CouponFunding;
  /** By variant id; lines out of scope are 0 or absent. */
  lineDiscounts: ReadonlyMap<string, Money>;
}

export interface SellerSplit {
  sellerId: string;
  lines: (PricedLine & { lineTotal: Money; discount: Money })[];
  /** Undiscounted. */
  subtotal: Money;
  discountAmount: Money;
  discountFunding: CouponFunding | null;
  commissionRate: Rate;
  commission: Money;
  sellerNet: Money;
}

export interface CheckoutMoney {
  /** One per seller, in the order each seller first appears in the cart. */
  sellers: SellerSplit[];
  /** What the customer pays for the items: Σ (subtotal − discount). */
  itemsTotal: Money;
  discountTotal: Money;
  deliveryFee: Money;
  total: Money;
}

/**
 * Commission and net of a seller order by who funds its discount (R-17, spec 09 §8.8): a platform coupon
 * (or none) takes commission on the undiscounted subtotal and the platform absorbs the discount; a seller
 * coupon takes it on the discounted subtotal, and the seller's net drops by the discount too.
 */
export function sellerOrderMoney(
  subtotal: Money,
  discount: { amount: Money; funding: CouponFunding | null },
  rate: Rate,
): { commission: Money; sellerNet: Money } {
  if (discount.funding === CouponFunding.SELLER) {
    const base = subtotal.minus(discount.amount);
    const commission = base.timesRate(rate);
    return { commission, sellerNet: base.minus(commission) };
  }
  const commission = subtotal.timesRate(rate);
  return { commission, sellerNet: subtotal.minus(commission) };
}

/**
 * The money of a checkout (overview §5, spec 09 §3.1 step 5, §8.8): line totals and their coupon shares,
 * the per-seller split with commission and net by funding (`sellerOrderMoney`, ROUND_HALF_UP to the
 * piastre), the paid items total, the one delivery fee of the checkout, and the total.
 */
export function computeCheckoutMoney(
  lines: readonly PricedLine[],
  commissionRates: ReadonlyMap<string, Rate>,
  deliveryFee: Money,
  coupon: CheckoutDiscount | null = null,
): CheckoutMoney {
  const bySeller = new Map<string, SellerSplit['lines']>();
  for (const line of lines) {
    const group = bySeller.get(line.sellerId) ?? [];
    group.push({
      ...line,
      lineTotal: line.unitPrice.timesQuantity(line.quantity),
      discount: coupon?.lineDiscounts.get(line.variantId) ?? Money.zero(),
    });
    bySeller.set(line.sellerId, group);
  }

  const sellers = [...bySeller.entries()].map(([sellerId, sellerLines]): SellerSplit => {
    const commissionRate = commissionRates.get(sellerId);
    if (!commissionRate) throw new Error(`no commission rate for seller ${sellerId}`);
    const subtotal = Money.sum(sellerLines.map((line) => line.lineTotal));
    const discountAmount = Money.sum(sellerLines.map((line) => line.discount));
    const discountFunding = coupon && !discountAmount.isZero() ? coupon.funding : null;
    return {
      sellerId,
      lines: sellerLines,
      subtotal,
      discountAmount,
      discountFunding,
      commissionRate,
      ...sellerOrderMoney(subtotal, { amount: discountAmount, funding: discountFunding }, commissionRate),
    };
  });

  const discountTotal = Money.sum(sellers.map((seller) => seller.discountAmount));
  const itemsTotal = Money.sum(sellers.map((seller) => seller.subtotal)).minus(discountTotal);
  return { sellers, itemsTotal, discountTotal, deliveryFee, total: itemsTotal.plus(deliveryFee) };
}
