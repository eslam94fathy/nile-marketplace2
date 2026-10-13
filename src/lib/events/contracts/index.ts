/** Every event of docs/spec/02-events.md v1.0 §2. */
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

import { CodRemittanceConfirmed } from './cod-remittance-confirmed.event';
import { InventoryStockStatusChanged } from './inventory-stock-status-changed.event';
import { NotificationEmailRequested } from './notification-email-requested.event';
import { OrderClosed } from './order-closed.event';
import { OrderPlaced } from './order-placed.event';
import { PaymentExpired } from './payment-expired.event';
import { PaymentFailed } from './payment-failed.event';
import { PaymentPaid } from './payment-paid.event';
import { PaymentRefundRecorded } from './payment-refund-recorded.event';
import { PayoutRecorded } from './payout-recorded.event';
import { SellerApproved } from './seller-approved.event';
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
] as const;
