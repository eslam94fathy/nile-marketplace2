/**
 * ordering module (docs/spec/09-ordering.md): checkout (the orchestrator), the order and its
 * per-seller split, snapshots, stored statuses and the money of each seller order.
 * Owns tables: orders, seller_orders, order_items, order_item_cancellations, order_status_history,
 * seller_order_status_history. No other module reads or writes them.
 * May call: customers, cart, catalog, sellers, inventory, payments, delivery. Nobody calls ordering
 * (architecture §2): it has no public service API, only event contracts and its routes.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { type ApiEnv } from '../../lib/config';
import { TOKENS } from '../../lib/di';
import { type OpenApiRegistry } from '../../lib/http';
import { type ILogger } from '../../lib/logger';
import { type RateLimiters, requireIdempotency } from '../../lib/middleware';
import { type ICache } from '../../pkg/cache';
import { AdminOrderController } from './controller/admin-order.controller';
import { OrderController } from './controller/order.controller';
import { SellerOrderController } from './controller/seller-order.controller';
import { OrderItemRepository } from './repository/order-item.repository';
import { OrderRepository } from './repository/order.repository';
import { SellerOrderRepository } from './repository/seller-order.repository';
import { StatusHistoryRepository } from './repository/status-history.repository';
import { orderingRoutes } from './routes';
import { CheckoutService } from './service/checkout.service';
import { OrderViewService } from './service/order-view.service';

export { OrderingErrorCode } from './errors';
export { OrderStatus, SellerOrderStatus } from './enums';

/** api process. Needs customers, cart, catalog, sellers, inventory, payments and delivery registered first. */
export function registerOrderingModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.OrderRepository, OrderRepository);
  container.registerSingleton(TOKENS.SellerOrderRepository, SellerOrderRepository);
  container.registerSingleton(TOKENS.OrderItemRepository, OrderItemRepository);
  container.registerSingleton(TOKENS.StatusHistoryRepository, StatusHistoryRepository);
  container.registerSingleton(TOKENS.CheckoutService, CheckoutService);
  container.registerSingleton(TOKENS.OrderViewService, OrderViewService);
  container.registerSingleton(TOKENS.OrderController, OrderController);
  container.registerSingleton(TOKENS.SellerOrderController, SellerOrderController);
  container.registerSingleton(TOKENS.AdminOrderController, AdminOrderController);
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
