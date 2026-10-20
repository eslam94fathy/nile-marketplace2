import { type ImageView } from '../../media';
import { type PaymentSummary } from '../../payments';
import { type OrderStatus, type SellerOrderStatus } from '../enums';
import { type Order, type OrderItem, type SellerOrder, type StatusHistoryEntry } from './order.model';

/** An order line with its snapshot image resolved to URLs (spec 09 §8.3); null when it has none. */
export type OrderItemView = OrderItem & { image: ImageView | null };

/** A seller order with everything an order detail shows of it. */
export interface SellerOrderDetail {
  sellerOrder: SellerOrder;
  businessName: string;
  items: OrderItemView[];
  history: StatusHistoryEntry<SellerOrderStatus>[];
}

/** Customer and admin order detail (spec 09 §4.1.3, §4.3). */
export interface OrderDetail {
  order: Order;
  payment: PaymentSummary | null;
  sellerOrders: SellerOrderDetail[];
  history: StatusHistoryEntry<OrderStatus>[];
}

/** A seller's view of one of its seller orders, with the parts of the order it may see (S-11). */
export interface SellerOrderView {
  sellerOrder: SellerOrder;
  order: Pick<Order, 'orderNumber' | 'paymentMethod'> & {
    dropoffGovernorate: { id: string; name: string };
  };
  items: OrderItemView[];
}
