/**
 * payments module (docs/spec/10-payments.md): one payment per checkout, COD or Kashier, refund flags
 * and COD collection tracking. Owns tables: payments, payment_refunds, payment_events. No other module
 * reads or writes them. May call: nobody (Kashier through the pkg/payments gateway). Reacts to
 * ordering's events and never calls ordering (architecture §2). This file is its only public surface.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { type ApiEnv } from '../../lib/config';
import { TOKENS } from '../../lib/di';
import {
  type EventHandlerDefinition,
  OrderClosed,
  SellerOrderCancelled,
  SellerOrderDelivered,
  SellerOrderItemsCancelled,
  SellerOrderReturned,
} from '../../lib/events';
import { type OpenApiRegistry } from '../../lib/http';
import { type ILogger } from '../../lib/logger';
import { requireIdempotency } from '../../lib/middleware';
import { type ICache } from '../../pkg/cache';
import { ORDER_ADJUSTMENTS_QUEUE } from './constants';
import { PaymentAdminController, PaymentWebhookController } from './controller/payment.controller';
import { PaymentEventRepository } from './repository/payment-event.repository';
import { PaymentRefundRepository } from './repository/payment-refund.repository';
import { PaymentRepository } from './repository/payment.repository';
import { OrderAdjustmentService } from './service/order-adjustment.service';
import { paymentAdminRoutes, paymentWebhookRoutes } from './routes';
import { KashierWebhookService } from './service/kashier-webhook.service';
import { PaymentAdminService } from './service/payment-admin.service';
import { PaymentDirectory } from './service/payment-directory.service';
import { PaymentSettlementService } from './service/payment-settlement.service';

export { PaymentMethod, PaymentStatus } from './enums';
export { PAYMENTS_PATHS } from './constants';
export { PaymentsErrorCode } from './errors';
export type { PaymentSummary } from './model/payment.model';
/** Inject with `TOKENS.PaymentDirectory`. */
export type {
  IPaymentDirectory,
  KashierSessionResult,
  ProviderStatus,
} from './service/payment-directory.service';
export type { SettlementOutcome } from './service/payment-settlement.service';

/**
 * Both processes: the public API (checkout, order views, the expiry job) and the order-adjustments
 * consumer. Needs `TOKENS.PaymentGateway` registered (infrastructure).
 */
export function registerPaymentsModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.PaymentRepository, PaymentRepository);
  container.registerSingleton(TOKENS.PaymentRefundRepository, PaymentRefundRepository);
  container.registerSingleton(TOKENS.PaymentEventRepository, PaymentEventRepository);
  container.registerSingleton(TOKENS.PaymentSettlementService, PaymentSettlementService);
  container.registerSingleton(TOKENS.PaymentDirectory, PaymentDirectory);
  container.registerSingleton(TOKENS.OrderAdjustmentService, OrderAdjustmentService);
}

/** api process: the webhook and the admin endpoints (spec 10 §4). */
export function registerPaymentsHttp(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.KashierWebhookService, KashierWebhookService);
  container.registerSingleton(TOKENS.PaymentAdminService, PaymentAdminService);
  container.registerSingleton(TOKENS.PaymentWebhookController, PaymentWebhookController);
  container.registerSingleton(TOKENS.PaymentAdminController, PaymentAdminController);
}

/** The webhook router: mounted before the global rate limit (spec 10 §4.1). */
export function createPaymentsWebhookRouter(container: DependencyContainer, basePath: string): Router {
  return paymentWebhookRoutes({
    webhooks: container.resolve<PaymentWebhookController>(TOKENS.PaymentWebhookController),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}

/** The admin payment routes, mounted at `basePath` (`/api/v1`). */
export function createPaymentsRouter(container: DependencyContainer, basePath: string): Router {
  return paymentAdminRoutes({
    admin: container.resolve<PaymentAdminController>(TOKENS.PaymentAdminController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    idempotency: requireIdempotency(
      container.resolve<ICache>(TOKENS.Cache),
      container.resolve<ApiEnv>(TOKENS.Env),
      container.resolve<ILogger>(TOKENS.Logger),
    ),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
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
