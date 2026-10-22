import { type ErrorDetail } from '../../../lib/error';
import { Money, type Rate } from '../../../lib/money';
import { type PaymentMethod } from '../../payments';
import { type SellerOrderStatus } from '../enums';
import { keptQuantity, type OrderItem, type PickupSnapshot, type ShippingSnapshot } from './order.model';

/** A customer's seller order as returns sees it before a request (spec 09 §8.7 `getReturnableItems`). */
export interface ReturnableSellerOrder {
  sellerOrderId: string;
  orderId: string;
  orderNumber: string;
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
  /** Always zero until coupons (OR-27). */
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

/**
 * The amount rule of spec 09 §8.7 with every discount at zero (OR-27). Every amount is taken over the
 * units still kept, as the difference before and after the return, so several returns of one seller
 * order add up exactly to what was booked at delivery: commission kept = round(kept subtotal × rate).
 * The lines are removed from the kept base one at a time in order-item id order, so each line's
 * commission telescopes to the total (OR-29). The lines must be valid (`returnLineProblems`).
 */
export function computeReturnAmounts(
  sellerOrder: { keptSubtotal: Money; commissionRate: Rate },
  items: readonly OrderItem[],
  lines: readonly ReturnLine[],
): { amounts: ReturnAmounts; lines: ReturnLineAmounts[] } {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = [...lines].sort((a, b) =>
    a.orderItemId < b.orderItemId ? -1 : a.orderItemId > b.orderItemId ? 1 : 0,
  );
  let base = sellerOrder.keptSubtotal;
  const lineAmounts = ordered.map((line): ReturnLineAmounts => {
    const item = byId.get(line.orderItemId);
    if (!item) throw new Error(`order item ${line.orderItemId} is not part of the seller order`);
    const subtotal = item.unitPrice.timesQuantity(line.quantity);
    const after = base.minus(subtotal);
    if (after.isNegative()) throw new Error('a return takes more than the kept subtotal');
    const commission = base
      .timesRate(sellerOrder.commissionRate)
      .minus(after.timesRate(sellerOrder.commissionRate));
    base = after;
    return {
      orderItemId: line.orderItemId,
      quantity: line.quantity,
      subtotal,
      discount: Money.zero(),
      paid: subtotal,
      commission,
    };
  });

  const itemsSubtotal = Money.sum(lineAmounts.map((l) => l.subtotal));
  const commissionReversed = Money.sum(lineAmounts.map((l) => l.commission));
  return {
    lines: lineAmounts,
    amounts: {
      itemsSubtotal,
      itemsPaid: Money.sum(lineAmounts.map((l) => l.paid)),
      commissionReversed,
      sellerNetReversed: itemsSubtotal.minus(commissionReversed),
      platformDiscountReversed: Money.zero(),
    },
  };
}
