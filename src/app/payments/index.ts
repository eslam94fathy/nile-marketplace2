/**
 * payments module (docs/spec/10-payments.md): one payment per checkout, COD or Kashier, refund flags
 * and COD collection tracking. Owns tables: payments, payment_refunds, payment_events. No other module
 * reads or writes them. May call: nobody (Kashier through a pkg gateway, from PR b). Reacts to
 * ordering's events and never calls ordering (architecture §2). This file is its only public surface.
 */
import { type DependencyContainer } from 'tsyringe';
import { TOKENS } from '../../lib/di';
import {
  type EventHandlerDefinition,
  OrderClosed,
  SellerOrderCancelled,
  SellerOrderDelivered,
  SellerOrderItemsCancelled,
  SellerOrderReturned,
} from '../../lib/events';
import { ORDER_ADJUSTMENTS_QUEUE } from './constants';
import { PaymentRefundRepository } from './repository/payment-refund.repository';
import { PaymentRepository } from './repository/payment.repository';
import { OrderAdjustmentService } from './service/order-adjustment.service';
import { PaymentDirectory } from './service/payment-directory.service';

export { PaymentMethod, PaymentStatus } from './enums';
export { PaymentsErrorCode } from './errors';
export type { PaymentSummary } from './model/payment.model';
/** Inject with `TOKENS.PaymentDirectory`. */
export type { IPaymentDirectory } from './service/payment-directory.service';

/** api (checkout, order views) and worker (the order-adjustments consumer). */
export function registerPaymentsModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.PaymentRepository, PaymentRepository);
  container.registerSingleton(TOKENS.PaymentRefundRepository, PaymentRefundRepository);
  container.registerSingleton(TOKENS.PaymentDirectory, PaymentDirectory);
  container.registerSingleton(TOKENS.OrderAdjustmentService, OrderAdjustmentService);
}

/** Consumer `payments.order-adjustments` (spec 10 UC-PA-3, spec 02 §2). */
export function createPaymentsHandlers(container: DependencyContainer): EventHandlerDefinition[] {
  const adjustments = container.resolve<OrderAdjustmentService>(TOKENS.OrderAdjustmentService);
  return [
    {
      name: ORDER_ADJUSTMENTS_QUEUE,
      events: [
        SellerOrderItemsCancelled,
        SellerOrderCancelled,
        SellerOrderReturned,
        SellerOrderDelivered,
        OrderClosed,
      ],
      handle: (envelope, trx) => adjustments.handle(envelope, trx),
    },
  ];
}
