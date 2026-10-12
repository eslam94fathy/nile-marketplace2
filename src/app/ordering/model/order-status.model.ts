import { OrderStatus, SellerOrderStatus } from '../enums';

/** Seller-order statuses that never change again (spec 09 §1.1). */
export const TERMINAL_SELLER_ORDER_STATUSES: readonly SellerOrderStatus[] = [
  SellerOrderStatus.DELIVERED,
  SellerOrderStatus.CANCELLED,
  SellerOrderStatus.RETURNED_TO_SELLER,
];

/**
 * Seller orders whose units the customer still pays for: not cancelled and not returned. The
 * order's items total (OR-13) and the summary item count (OR-9) both count only these.
 */
export const isBilled = (status: SellerOrderStatus): boolean =>
  status !== SellerOrderStatus.CANCELLED && status !== SellerOrderStatus.RETURNED_TO_SELLER;

export const isTerminal = (status: SellerOrderStatus): boolean =>
  TERMINAL_SELLER_ORDER_STATUSES.includes(status);

/**
 * The stored order status, derived from its seller orders after every change (spec 09 §1.1), rules
 * in order: any pending_payment → pending_payment; all terminal → completed / partially_completed /
 * cancelled (the close step); every non-cancelled one placed → placed; otherwise in_progress.
 */
export function deriveOrderStatus(sellerOrderStatuses: readonly SellerOrderStatus[]): OrderStatus {
  if (sellerOrderStatuses.length === 0) throw new Error('an order has at least one seller order');
  if (sellerOrderStatuses.includes(SellerOrderStatus.PENDING_PAYMENT)) return OrderStatus.PENDING_PAYMENT;

  if (sellerOrderStatuses.every(isTerminal)) {
    const delivered = sellerOrderStatuses.filter((status) => status === SellerOrderStatus.DELIVERED).length;
    if (delivered === sellerOrderStatuses.length) return OrderStatus.COMPLETED;
    return delivered > 0 ? OrderStatus.PARTIALLY_COMPLETED : OrderStatus.CANCELLED;
  }

  const open = sellerOrderStatuses.filter((status) => status !== SellerOrderStatus.CANCELLED);
  return open.every((status) => status === SellerOrderStatus.PLACED)
    ? OrderStatus.PLACED
    : OrderStatus.IN_PROGRESS;
}

export type ClosedOrderStatus =
  typeof OrderStatus.COMPLETED | typeof OrderStatus.PARTIALLY_COMPLETED | typeof OrderStatus.CANCELLED;

/** A closed order (completed, partially completed or cancelled) never changes again. */
export const isClosed = (status: OrderStatus): status is ClosedOrderStatus =>
  status === OrderStatus.COMPLETED ||
  status === OrderStatus.PARTIALLY_COMPLETED ||
  status === OrderStatus.CANCELLED;
