/**
 * ordering module (docs/spec/09-ordering.md): checkout (the orchestrator), the order and its
 * per-seller split, snapshots, stored statuses and the money of each seller order.
 * Owns tables: orders, seller_orders, order_items, order_item_cancellations, order_status_history,
 * seller_order_status_history. No other module reads or writes them.
 * May call: customers, cart, catalog, sellers, inventory, payments, delivery, media. From R2 its public
 * API (`IOrderingDirectory`, spec 09 §8.1) is read by realtime, notifications and support; ordering calls
 * none of them, so the graph stays acyclic (architecture v2.0 §14.2).
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { type ApiEnv, type Env } from '../../lib/config';
import { TOKENS } from '../../lib/di';
import {
  type EventHandlerDefinition,
  PaymentFailed,
  PaymentPaid,
  ShipmentAttemptFailed,
  ShipmentDelivered,
  ShipmentOutForDelivery,
  ShipmentPickedUp,
} from '../../lib/events';
import { type OpenApiRegistry } from '../../lib/http';
import { type JobDefinition } from '../../lib/jobs';
import { type ILogger } from '../../lib/logger';
import { type RateLimiters, requireIdempotency } from '../../lib/middleware';
import { type ICache } from '../../pkg/cache';
import { AdminOrderController } from './controller/admin-order.controller';
import { OrderController } from './controller/order.controller';
import { SellerOrderController } from './controller/seller-order.controller';
import { OrderItemCancellationRepository } from './repository/order-item-cancellation.repository';
import { OrderItemRepository } from './repository/order-item.repository';
import { OrderRepository } from './repository/order.repository';
import { SellerOrderRepository } from './repository/seller-order.repository';
import { StatusHistoryRepository } from './repository/status-history.repository';
import { PAYMENT_UPDATES_QUEUE, SHIPMENT_UPDATES_QUEUE } from './constants';
import { orderingRoutes } from './routes';
import { AcceptanceTimeoutJob } from './service/acceptance-timeout.job';
import { CheckoutService } from './service/checkout.service';
import { OrderActionService } from './service/order-action.service';
import { OrderLifecycleService } from './service/order-lifecycle.service';
import { OrderViewService } from './service/order-view.service';
import { OrderingDirectory } from './service/ordering-directory.service';
import { PaymentExpiryJob } from './service/payment-expiry.job';
import { PaymentUpdateService } from './service/payment-update.service';
import { ShipmentUpdateService } from './service/shipment-update.service';

export { OrderingErrorCode } from './errors';
export { OrderStatus, SellerOrderStatus } from './enums';
export type { NotificationParty, OrderLink } from './model/notification-party.model';
/** Inject with `TOKENS.OrderingDirectory`. */
export type { IOrderingDirectory } from './service/ordering-directory.service';

/** What both processes need: the repositories and the shared order write path. Needs inventory first. */
function registerOrderingCore(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.OrderRepository, OrderRepository);
  container.registerSingleton(TOKENS.SellerOrderRepository, SellerOrderRepository);
  container.registerSingleton(TOKENS.OrderItemRepository, OrderItemRepository);
  container.registerSingleton(TOKENS.StatusHistoryRepository, StatusHistoryRepository);
  container.registerSingleton(TOKENS.OrderItemCancellationRepository, OrderItemCancellationRepository);
  container.registerSingleton(TOKENS.OrderLifecycleService, OrderLifecycleService);
  container.registerSingleton(TOKENS.OrderingDirectory, OrderingDirectory);
}

/** api process. Needs customers, cart, catalog, sellers, inventory, payments, delivery and media registered first. */
export function registerOrderingModule(container: DependencyContainer): void {
  registerOrderingCore(container);
  container.registerSingleton(TOKENS.CheckoutService, CheckoutService);
  container.registerSingleton(TOKENS.OrderActionService, OrderActionService);
  container.registerSingleton(TOKENS.OrderViewService, OrderViewService);
  container.registerSingleton(TOKENS.OrderController, OrderController);
  container.registerSingleton(TOKENS.SellerOrderController, SellerOrderController);
  container.registerSingleton(TOKENS.AdminOrderController, AdminOrderController);
}

/** worker process: what the consumers and jobs need. Needs inventory registered first. */
export function registerOrderingWorker(container: DependencyContainer): void {
  registerOrderingCore(container);
  container.registerSingleton(TOKENS.ShipmentUpdateService, ShipmentUpdateService);
  container.registerSingleton(TOKENS.PaymentUpdateService, PaymentUpdateService);
}

/** Consumers `ordering.payment-updates` (spec 09 §3.11) and `ordering.shipment-updates` (UC-OR-6, UC-OR-8). */
export function createOrderingHandlers(container: DependencyContainer): EventHandlerDefinition[] {
  const shipments = container.resolve<ShipmentUpdateService>(TOKENS.ShipmentUpdateService);
  const payments = container.resolve<PaymentUpdateService>(TOKENS.PaymentUpdateService);
  return [
    {
      name: PAYMENT_UPDATES_QUEUE,
      events: [PaymentPaid, PaymentFailed],
      handle: (envelope, trx) => payments.handle(envelope, trx),
    },
    {
      name: SHIPMENT_UPDATES_QUEUE,
      events: [ShipmentPickedUp, ShipmentOutForDelivery, ShipmentAttemptFailed, ShipmentDelivered],
      handle: (envelope, trx) => shipments.handle(envelope, trx),
    },
  ];
}

/** The order jobs (spec 09 §3.10), on a container with the ordering core registered. */
export function createOrderingJobs(
  container: DependencyContainer,
  env: Pick<
    Env,
    | 'JOB_SELLER_ACCEPTANCE_TIMEOUT_INTERVAL_MS'
    | 'JOB_KASHIER_PAYMENT_EXPIRY_INTERVAL_MS'
    | 'ORDER_JOBS_BATCH_SIZE'
  >,
): JobDefinition[] {
  container.registerSingleton(TOKENS.AcceptanceTimeoutJob, AcceptanceTimeoutJob);
  container.registerSingleton(TOKENS.PaymentExpiryJob, PaymentExpiryJob);
  const timeout = container.resolve<AcceptanceTimeoutJob>(TOKENS.AcceptanceTimeoutJob);
  const expiry = container.resolve<PaymentExpiryJob>(TOKENS.PaymentExpiryJob);
  return [
    {
      name: 'kashier-payment-expiry',
      intervalMs: env.JOB_KASHIER_PAYMENT_EXPIRY_INTERVAL_MS,
      run: () => expiry.run(env.ORDER_JOBS_BATCH_SIZE),
    },
    {
      name: 'seller-acceptance-timeout',
      intervalMs: env.JOB_SELLER_ACCEPTANCE_TIMEOUT_INTERVAL_MS,
      run: () => timeout.run(env.ORDER_JOBS_BATCH_SIZE),
    },
  ];
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createOrderingRouter(container: DependencyContainer, basePath: string): Router {
  return orderingRoutes({
    orders: container.resolve<OrderController>(TOKENS.OrderController),
    sellerOrders: container.resolve<SellerOrderController>(TOKENS.SellerOrderController),
    adminOrders: container.resolve<AdminOrderController>(TOKENS.AdminOrderController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    rateLimiters: container.resolve<RateLimiters>(TOKENS.RateLimiters),
    idempotency: requireIdempotency(
      container.resolve<ICache>(TOKENS.Cache),
      container.resolve<ApiEnv>(TOKENS.Env),
      container.resolve<ILogger>(TOKENS.Logger),
    ),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
