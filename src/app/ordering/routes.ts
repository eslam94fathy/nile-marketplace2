import { type RequestHandler, Router } from 'express';
import { type ParameterObject } from 'openapi3-ts/oas31';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, byUser, RateLimitClass, type RateLimiters, requireRole } from '../../lib/middleware';
import { ORDERING_PATHS as P } from './constants';
import { type AdminOrderController } from './controller/admin-order.controller';
import { type OrderController } from './controller/order.controller';
import { type SellerOrderController } from './controller/seller-order.controller';
import { CheckoutDto } from './dto/order-request.dto';
import {
  AdminOrderDetailDto,
  AdminOrderSummaryDto,
  CheckoutResultDto,
  OrderDetailDto,
  OrderSummaryDto,
  SellerOrderDto,
} from './dto/order-response.dto';

export interface OrderingRouteDeps {
  orders: OrderController;
  sellerOrders: SellerOrderController;
  adminOrders: AdminOrderController;
  jwtVerifier: JwtVerifier;
  rateLimiters: RateLimiters;
  idempotency: RequestHandler;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

const page: readonly ParameterObject[] = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
  { name: 'cursor', in: 'query', schema: { type: 'string' } },
  { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] } },
  { name: 'status[eq]', in: 'query', schema: { type: 'string' } },
  { name: 'status[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
  { name: 'createdAt[gte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
  { name: 'createdAt[lte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
];

/** Spec 09 §4: customer (§4.1), seller (§4.2, any seller status) and admin (§4.3) order routes. */
export function orderingRoutes(deps: OrderingRouteDeps): Router {
  const { orders, sellerOrders, adminOrders, docs, basePath } = deps;
  const router = Router();
  const auth = authenticate(deps.jwtVerifier);
  const customerOnly = [auth, requireRole(UserRole.CUSTOMER)];
  const sellerOnly = [auth, requireRole(UserRole.SELLER)];
  const adminOnly = [auth, requireRole(UserRole.ADMIN)];
  // Per user, fail closed (architecture §8, OR-10).
  const checkoutLimit = deps.rateLimiters.limit(RateLimitClass.CHECKOUT, byUser);

  router.post(P.CHECKOUT, ...customerOnly, checkoutLimit, deps.idempotency, orders.checkout);
  router.get(P.ORDERS, ...customerOnly, orders.list);
  router.get(P.ORDER, ...customerOnly, orders.get);

  router.get(P.SELLER_ORDERS, ...sellerOnly, sellerOrders.list);
  router.get(P.SELLER_ORDER, ...sellerOnly, sellerOrders.get);

  router.get(P.ADMIN_ORDERS, ...adminOnly, adminOrders.list);
  router.get(P.ADMIN_ORDER, ...adminOnly, adminOrders.get);

  const customer = { tags: ['orders'], auth: true } as const;
  docs.add({
    ...customer,
    method: 'post',
    path: `${basePath}${P.CHECKOUT}`,
    summary:
      'Place an order from my cart, split per seller; reserves stock and empties the cart. COD only until the Kashier flow lands (CART_EMPTY 422, CART_HAS_ISSUES 409, ADDRESS_NOT_FOUND 422, GOVERNORATE_NOT_DELIVERABLE 422, ORDER_TOTAL_CHANGED 409, INSUFFICIENT_STOCK 409)',
    requestBody: CheckoutDto,
    idempotent: true,
    responses: { 201: { description: 'The placed order', body: CheckoutResultDto } },
  });
  docs.add({
    ...customer,
    method: 'get',
    path: `${basePath}${P.ORDERS}`,
    summary: 'My orders. Filters: status[eq|in], createdAt[gte|lte]. Sort: createdAt (default -createdAt)',
    query: page,
    responses: {
      200: { description: 'One page of my orders', body: OrderSummaryDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...customer,
    method: 'get',
    path: `${basePath}${P.ORDER}`,
    summary: 'One of my orders with its seller orders, items and timelines (ORDER_NOT_FOUND)',
    responses: { 200: { description: 'The order', body: OrderDetailDto } },
  });

  const seller = { tags: ['seller: orders'], auth: true } as const;
  docs.add({
    ...seller,
    method: 'get',
    path: `${basePath}${P.SELLER_ORDERS}`,
    summary:
      'My seller orders (never those awaiting payment; no customer details, S-11). Filters: status[eq|in], createdAt[gte|lte]. Sort: createdAt (default -createdAt)',
    query: page,
    responses: {
      200: {
        description: 'One page of my seller orders',
        body: SellerOrderDto,
        isArray: true,
        paginated: true,
      },
    },
  });
  docs.add({
    ...seller,
    method: 'get',
    path: `${basePath}${P.SELLER_ORDER}`,
    summary: 'One of my seller orders (SELLER_ORDER_NOT_FOUND)',
    responses: { 200: { description: 'The seller order', body: SellerOrderDto } },
  });

  const admin = { tags: ['admin: orders'], auth: true } as const;
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${P.ADMIN_ORDERS}`,
    summary:
      'All orders. Filters: status[eq|in], orderNumber[eq], customerId[eq], createdAt[gte|lte]. Sort: createdAt (default -createdAt)',
    query: [
      ...page,
      { name: 'orderNumber[eq]', in: 'query', schema: { type: 'string' } },
      { name: 'customerId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
    ],
    responses: {
      200: { description: 'One page of orders', body: AdminOrderSummaryDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...admin,
    method: 'get',
    path: `${basePath}${P.ADMIN_ORDER}`,
    summary: 'An order with the money of each seller order and the full status histories (ORDER_NOT_FOUND)',
    responses: { 200: { description: 'The order', body: AdminOrderDetailDto } },
  });

  return router;
}
