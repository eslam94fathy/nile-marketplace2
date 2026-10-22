/** Every event of docs/spec/02-events.md §2 (v1.0, plus the R2 events as their phases land). */
export * from './define-event';
export * from './shared-types';
export * from './notification-email-requested.event';
export * from './seller-approved.event';
export * from './seller-suspended.event';
export * from './inventory-stock-status-changed.event';
export * from './order-placed.event';
export * from './seller-order-ready-for-pickup.event';
export * from './seller-order-items-cancelled.event';
export * from './seller-order-cancelled.event';
export * from './seller-order-returned.event';
export * from './seller-order-delivered.event';
export * from './order-closed.event';
export * from './payment-paid.event';
export * from './payment-failed.event';
export * from './payment-expired.event';
export * from './payment-refund-recorded.event';
export * from './shipment-assigned.event';
export * from './shipment-picked-up.event';
export * from './shipment-out-for-delivery.event';
export * from './shipment-attempt-failed.event';
export * from './shipment-delivered.event';
export * from './cod-remittance-confirmed.event';
export * from './payout-recorded.event';
export * from './media-uploaded.event';
export * from './media-ready.event';
export * from './media-failed.event';
export * from './user-suspended.event';
export * from './user-sessions-revoked.event';
export * from './seller-order-accepted.event';
export * from './notification-push-requested.event';
export * from './support-ticket-opened.event';
export * from './support-message-created.event';
export * from './support-ticket-assigned.event';
export * from './support-ticket-status-changed.event';
export * from './review-created.event';
export * from './review-replied.event';
export * from './review-rating-changed.event';
export * from './product-blocked.event';
export * from './return-status-changed.event';
export * from './return-approved.event';
export * from './return-completed.event';
export * from './return-shipment.events';
export * from './payment-refunded.event';
export * from './coupon-blocked.event';

import { CodRemittanceConfirmed } from './cod-remittance-confirmed.event';
import { InventoryStockStatusChanged } from './inventory-stock-status-changed.event';
import { MediaFailed } from './media-failed.event';
import { CouponBlocked } from './coupon-blocked.event';
import { MediaReady } from './media-ready.event';
import { MediaUploaded } from './media-uploaded.event';
import { NotificationEmailRequested } from './notification-email-requested.event';
import { NotificationPushRequested } from './notification-push-requested.event';
import { OrderClosed } from './order-closed.event';
import { OrderPlaced } from './order-placed.event';
import { PaymentExpired } from './payment-expired.event';
import { PaymentFailed } from './payment-failed.event';
import { PaymentPaid } from './payment-paid.event';
import { PaymentRefundRecorded } from './payment-refund-recorded.event';
import { PaymentRefunded } from './payment-refunded.event';
import { PayoutRecorded } from './payout-recorded.event';
import { ProductBlocked, ProductUnblocked } from './product-blocked.event';
import { ReturnApproved } from './return-approved.event';
import { ReturnCompleted } from './return-completed.event';
import {
  ReturnShipmentDelivered,
  ReturnShipmentFailed,
  ReturnShipmentPickedUp,
} from './return-shipment.events';
import { ReturnStatusChanged } from './return-status-changed.event';
import { ReviewCreated } from './review-created.event';
import { ReviewRatingChanged } from './review-rating-changed.event';
import { ReviewReplied } from './review-replied.event';
import { SellerApproved } from './seller-approved.event';
import { SellerOrderAccepted } from './seller-order-accepted.event';
import { SellerOrderCancelled } from './seller-order-cancelled.event';
import { SellerOrderDelivered } from './seller-order-delivered.event';
import { SellerOrderItemsCancelled } from './seller-order-items-cancelled.event';
import { SellerOrderReadyForPickup } from './seller-order-ready-for-pickup.event';
import { SellerOrderReturned } from './seller-order-returned.event';
import { SellerSuspended } from './seller-suspended.event';
import { ShipmentAssigned } from './shipment-assigned.event';
import { ShipmentAttemptFailed } from './shipment-attempt-failed.event';
import { ShipmentDelivered } from './shipment-delivered.event';
import { ShipmentOutForDelivery } from './shipment-out-for-delivery.event';
import { ShipmentPickedUp } from './shipment-picked-up.event';
import { UserSessionsRevoked } from './user-sessions-revoked.event';
import { SupportMessageCreated } from './support-message-created.event';
import { SupportTicketAssigned } from './support-ticket-assigned.event';
import { SupportTicketOpened } from './support-ticket-opened.event';
import { SupportTicketStatusChanged } from './support-ticket-status-changed.event';
import { UserSuspended } from './user-suspended.event';

export const ALL_EVENT_CONTRACTS = [
  NotificationEmailRequested,
  SellerApproved,
  SellerSuspended,
  InventoryStockStatusChanged,
  OrderPlaced,
  SellerOrderReadyForPickup,
  SellerOrderItemsCancelled,
  SellerOrderCancelled,
  SellerOrderReturned,
  SellerOrderDelivered,
  OrderClosed,
  PaymentPaid,
  PaymentFailed,
  PaymentExpired,
  PaymentRefundRecorded,
  ShipmentAssigned,
  ShipmentPickedUp,
  ShipmentOutForDelivery,
  ShipmentAttemptFailed,
  ShipmentDelivered,
  CodRemittanceConfirmed,
  PayoutRecorded,
  MediaUploaded,
  MediaReady,
  MediaFailed,
  UserSuspended,
  UserSessionsRevoked,
  SellerOrderAccepted,
  NotificationPushRequested,
  SupportTicketOpened,
  SupportMessageCreated,
  SupportTicketAssigned,
  SupportTicketStatusChanged,
  ReviewCreated,
  ReviewReplied,
  ReviewRatingChanged,
  ProductBlocked,
  ProductUnblocked,
  ReturnStatusChanged,
  ReturnApproved,
  ReturnCompleted,
  ReturnShipmentPickedUp,
  ReturnShipmentDelivered,
  ReturnShipmentFailed,
  PaymentRefunded,
  CouponBlocked,
] as const;
