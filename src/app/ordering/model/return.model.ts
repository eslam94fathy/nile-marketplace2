import { type ErrorDetail } from '../../../lib/error';
import { Money, type Rate } from '../../../lib/money';
import { type PaymentMethod } from '../../payments';
import { CouponFunding } from '../../promotions';
import { type SellerOrderStatus } from '../enums';
import {
  keptQuantity,
  type OrderItem,
  paidSubtotal,
  type PickupSnapshot,
  type SellerOrder,
  type ShippingSnapshot,
} from './order.model';

/** A customer's seller order as returns sees it before a request (spec 09 §8.7 `getReturnableItems`). */
export interface ReturnableSellerOrder {
  sellerOrderId: string;
  orderId: string;
  orderNumber: string;
  sellerId: string;
  status: SellerOrderStatus;
  deliveredAt: Date | null;
  paymentMethod: PaymentMethod;
  /** The order's drop-off governorate: the return fee is its current delivery fee (RE-5). */
  dropoffGovernorateId: string;
  /** Lines with units left to return. */
  items: ReturnableItem[];
}

export interface ReturnableItem {
  orderItemId: string;
  productName: string;
  attributes: { attribute: string; value: string }[];
  imageMediaId: string | null;
  /** quantity − cancelled − returned */
  returnable: number;
  /** Indicative: the exact share of `k` units comes from the amount rule (spec 09 §8.7). */
  paidUnitAmount: Money;
}

/** An order line as the return views show it (spec 09 OR-30), whatever its units' state. */
export interface OrderItemSnapshot {
  orderItemId: string;
  sellerOrderId: string;
  /** What a restock puts back (spec 07 §8). */
  variantId: string;
  productName: string;
  attributes: { attribute: string; value: string }[];
  imageMediaId: string | null;
  unitPrice: Money;
  /** With `discountOriginal`, the coupon share of returned units (spec 09 §8.7). */
  quantity: number;
  discountOriginal: Money;
}

/** One order line of a return. */
export interface ReturnLine {
  orderItemId: string;
  quantity: number;
}

/** What a return takes back (spec 09 §8.7); the event and booking amounts of `return.completed`. */
export interface ReturnAmounts {
  itemsSubtotal: Money;
  itemsPaid: Money;
  commissionReversed: Money;
  sellerNetReversed: Money;
  /** The discount share of a platform-funded coupon, given back to the platform (spec 12 row 11). */
  platformDiscountReversed: Money;
}

/** One `order_item_returns` row. */
export interface ReturnLineAmounts {
  orderItemId: string;
  quantity: number;
  subtotal: Money;
  discount: Money;
  paid: Money;
  commission: Money;
}

/** Where the return shipment goes (spec 09 §8.7 `getReturnLogistics`): from the customer to the seller. */
export interface ReturnLogistics {
  /** For the return shipment's snapshot (spec 18 RE-23). */
  orderNumber: string;
  paymentMethod: PaymentMethod;
  /** The order's drop-off snapshot: the customer. */
  pickup: ShippingSnapshot;
  /** The seller order's pickup snapshot and the seller's live business name. */
  dropoff: PickupSnapshot & { businessName: string };
}

/**
 * Checks the lines against the seller order's items: each item once, of this seller order, with
 * `1 ≤ quantity ≤ kept`. Returns one detail per offending line (empty when all are fine).
 */
export function returnLineProblems(items: readonly OrderItem[], lines: readonly ReturnLine[]): ErrorDetail[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const problems: ErrorDetail[] = [];
  for (const line of lines) {
    const item = byId.get(line.orderItemId);
    const returnable = item ? keptQuantity(item) : 0;
    const duplicate = seen.has(line.orderItemId);
    seen.add(line.orderItemId);
    if (
      !item ||
      duplicate ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > returnable
    ) {
      problems.push({
        field: 'items',
        value: line.orderItemId,
        constraint: !item ? 'part_of_seller_order' : duplicate ? 'unique' : 'returnable',
        message: !item
          ? 'not an item of this seller order'
          : duplicate
            ? 'listed twice'
            : `returnable: ${returnable}`,
      });
    }
  }
  return problems;
}

/** A line's coupon share on `kept` of its units (spec 09 §8.7): round(discountOriginal × kept / quantity). */
export const keptDiscountOf = (item: OrderItem, kept: number): Money =>
  item.discountOriginal.timesRatio(kept, item.quantity);

/** What a seller order still holds before a return: the base its commission is taken on (§8.7). */
export interface ReturnBase {
  /** subtotal − returned subtotal (undiscounted). */
  keptSubtotal: Money;
  /** (subtotal − discount) − returned paid. */
  keptPaid: Money;
  discountFunding: CouponFunding | null;
  commissionRate: Rate;
}

/** The base of a seller order: its delivered amounts less what its returns already took. */
export function returnBaseOf(sellerOrder: SellerOrder): ReturnBase {
  return {
    keptSubtotal: sellerOrder.subtotal.minus(sellerOrder.returnedSubtotal),
    keptPaid: paidSubtotal(sellerOrder).minus(sellerOrder.returnedPaid),
    discountFunding: sellerOrder.discountFunding,
    commissionRate: sellerOrder.commissionRate,
  };
}

/**
 * The amount rule of spec 09 §8.7 (OR-29, spec 19 PR-19). Every amount is taken over the units still
 * kept, as the difference before and after the return, so several returns of one seller order add up
 * exactly to what was booked at delivery:
 * - a line's discount share = kept share before − after (`keptDiscountOf`); its paid share = subtotal
 *   share − discount share;
 * - commission kept = round(base × rate), the base being the kept subtotal (platform coupon or none) or the
 *   kept paid subtotal (seller coupon, R-17). The lines are removed from the base one at a time in
 *   order-item id order, so each line's commission telescopes to the total (OR-29);
 * - the seller's net reversed is what left its base less the commission reversed; a platform coupon's
 *   discount share is reversed to the platform.
 * The lines must be valid (`returnLineProblems`).
 */
export function computeReturnAmounts(
  base: ReturnBase,
  items: readonly OrderItem[],
  lines: readonly ReturnLine[],
): { amounts: ReturnAmounts; lines: ReturnLineAmounts[] } {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = [...lines].sort((a, b) =>
    a.orderItemId < b.orderItemId ? -1 : a.orderItemId > b.orderItemId ? 1 : 0,
  );
  const onPaid = base.discountFunding === CouponFunding.SELLER;
  let kept = onPaid ? base.keptPaid : base.keptSubtotal;
  const lineAmounts = ordered.map((line): ReturnLineAmounts => {
    const item = byId.get(line.orderItemId);
    if (!item) throw new Error(`order item ${line.orderItemId} is not part of the seller order`);
    const keptUnits = keptQuantity(item);
    const subtotal = item.unitPrice.timesQuantity(line.quantity);
    const discount = keptDiscountOf(item, keptUnits).minus(keptDiscountOf(item, keptUnits - line.quantity));
    const paid = subtotal.minus(discount);
    const after = kept.minus(onPaid ? paid : subtotal);
    if (after.isNegative()) throw new Error('a return takes more than the seller order keeps');
    const commission = kept.timesRate(base.commissionRate).minus(after.timesRate(base.commissionRate));
    kept = after;
    return { orderItemId: line.orderItemId, quantity: line.quantity, subtotal, discount, paid, commission };
  });

  const itemsSubtotal = Money.sum(lineAmounts.map((l) => l.subtotal));
  const itemsPaid = Money.sum(lineAmounts.map((l) => l.paid));
  const commissionReversed = Money.sum(lineAmounts.map((l) => l.commission));
  const discountReversed = itemsSubtotal.minus(itemsPaid);
  return {
    lines: lineAmounts,
    amounts: {
      itemsSubtotal,
      itemsPaid,
      commissionReversed,
      sellerNetReversed: (onPaid ? itemsPaid : itemsSubtotal).minus(commissionReversed),
      platformDiscountReversed:
        base.discountFunding === CouponFunding.PLATFORM ? discountReversed : Money.zero(),
    },
  };
}
