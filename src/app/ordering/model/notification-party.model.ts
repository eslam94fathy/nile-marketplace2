import { type OrderStatus, type SellerOrderStatus } from '../enums';

/** Who an order concerns, with current statuses (spec 09 §8.1, spec 02 §6.3 recipient resolution). */
export interface NotificationParty {
  orderId: string;
  orderNumber: string;
  customerId: string;
  status: OrderStatus;
  /** Every seller order of the order, oldest first, whichever ids were asked for. */
  sellerOrders: { sellerOrderId: string; sellerId: string; status: SellerOrderStatus }[];
}

/** An order (and optionally one of its seller orders) a ticket may point at (spec 16 UC-SU-1). */
export interface OrderLink {
  orderId: string;
  orderNumber: string;
  sellerOrderId: string | null;
}
