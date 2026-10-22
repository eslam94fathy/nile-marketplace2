import { type Money, type Rate } from '../../../lib/money';
import { type PaymentMethod } from '../../payments';
import { type CouponFunding } from '../../promotions';
import {
  type ActorRole,
  type OrderStatus,
  type SellerOrderCancelReason,
  type SellerOrderStatus,
} from '../enums';

/** The shipping snapshot taken at checkout (spec 09 §3.1, database §8 `ship_*`). */
export interface ShippingSnapshot {
  recipientName: string;
  recipientPhone: string;
  governorateId: string;
  governorateName: string;
  city: string;
  area: string;
  street: string;
  building: string;
  floor: string | null;
  apartment: string | null;
  landmark: string | null;
}

export interface PickupSnapshot {
  governorateId: string;
  phone: string;
  city: string;
  area: string;
  street: string;
  building: string;
  landmark: string | null;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  itemsTotal: Money;
  deliveryFee: Money;
  agentFeeShareRate: Rate;
  total: Money;
  /** The checkout's coupon (spec 09 §8.8); null without one. */
  couponId: string | null;
  couponCode: string | null;
  /** The discount the billed seller orders still carry (like `itemsTotal`, OR-13); 0 without a coupon. */
  discountTotal: Money;
  shipping: ShippingSnapshot;
  paymentExpiresAt: Date | null;
  placedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

export interface SellerOrder {
  id: string;
  orderId: string;
  sellerId: string;
  status: SellerOrderStatus;
  subtotal: Money;
  commissionRate: Rate;
  commission: Money;
  sellerNet: Money;
  /** The coupon share its kept units carry (OR-31); `subtotal` stays undiscounted. */
  discountAmount: Money;
  /** Who funds `discountAmount`; null when it is 0. */
  discountFunding: CouponFunding | null;
  /** Sums of its returns, next to the delivered amounts (spec 09 §8.7); zero until a return completes. */
  returnedSubtotal: Money;
  returnedPaid: Money;
  returnedCommission: Money;
  returnedSellerNet: Money;
  pickup: PickupSnapshot;
  acceptDeadlineAt: Date | null;
  cancelReason: SellerOrderCancelReason | null;
  cancelledByUserId: string | null;
  acceptedAt: Date | null;
  readyAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

export interface OrderItem {
  id: string;
  sellerOrderId: string;
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  attributes: { attribute: string; value: string }[];
  unitPrice: Money;
  quantity: number;
  cancelledQuantity: number;
  /** Units returned (spec 09 §8.7); `lineTotal` keeps them, a return leaves the delivered amounts. */
  returnedQuantity: number;
  lineTotal: Money;
  /** The line's coupon share at checkout (spec 09 §8.8). */
  discountOriginal: Money;
  /** The share its kept units still carry: round(discountOriginal × kept / quantity) (§8.7). */
  discountAmount: Money;
  /** The variant's image at checkout (spec 09 §8.3); null when it had none. */
  imageMediaId: string | null;
}

/** Units still to deliver on a line (spec 09 §3.5). */
export const openQuantity = (item: OrderItem): number => item.quantity - item.cancelledQuantity;

/** Units the customer keeps: not cancelled, not returned (spec 09 §8.7, OR-9). */
export const keptQuantity = (item: OrderItem): number =>
  item.quantity - item.cancelledQuantity - item.returnedQuantity;

/** What the customer pays for a seller order's items: the subtotal less its coupon share. */
export const paidSubtotal = (sellerOrder: Pick<SellerOrder, 'subtotal' | 'discountAmount'>): Money =>
  sellerOrder.subtotal.minus(sellerOrder.discountAmount);

/** One row of an order or seller-order status history (append-only). */
export interface StatusHistoryEntry<S extends string> {
  /** The order or seller order the row belongs to. */
  subjectId: string;
  fromStatus: S | null;
  toStatus: S;
  actorRole: ActorRole;
  actorUserId: string | null;
  reason: string | null;
  createdAt: Date;
}

/** A list row: the order plus what the summary counts (spec 09 §4.1.3, OR-9). */
export interface OrderListEntry {
  order: Order;
  itemCount: number;
  sellerOrderCount: number;
}
