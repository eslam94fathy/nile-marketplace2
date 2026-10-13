import { type RequestHandler, Router } from 'express';
import { type ParameterObject } from 'openapi3-ts/oas31';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, byUser, RateLimitClass, type RateLimiters, requireRole } from '../../lib/middleware';
import { ORDERING_PATHS as P } from './constants';
import { type AdminOrderController } from './controller/admin-order.controller';
import { type OrderController } from './controller/order.controller';
import { type SellerOrderController } from './controller/seller-order.controller';
import { CancelOrderItemDto, CancelSellerOrderDto, CheckoutDto } from './dto/order-request.dto';
import {
  AdminOrderDetailDto,
  AdminOrderSummaryDto,
  CheckoutResultDto,
  KashierSessionDto,
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
  router.post(P.KASHIER_SESSION, ...customerOnly, checkoutLimit, orders.kashierSession);
  router.post(P.CUSTOMER_CANCEL, ...customerOnly, deps.idempotency, orders.cancelSellerOrder);

  router.get(P.SELLER_ORDERS, ...sellerOnly, sellerOrders.list);
  router.get(P.SELLER_ORDER, ...sellerOnly, sellerOrders.get);
  router.post(P.SELLER_ACCEPT, ...sellerOnly, sellerOrders.accept);
  router.post(P.SELLER_READY, ...sellerOnly, sellerOrders.ready);
  router.post(P.SELLER_CANCEL, ...sellerOnly, deps.idempotency, sellerOrders.cancel);
  router.post(P.SELLER_ITEM_CANCEL, ...sellerOnly, deps.idempotency, sellerOrders.cancelItems);
  router.post(P.SELLER_RETURN_RECEIVED, ...sellerOnly, deps.idempotency, sellerOrders.returnReceived);

  router.get(P.ADMIN_ORDERS, ...adminOnly, adminOrders.list);
  router.get(P.ADMIN_ORDER, ...adminOnly, adminOrders.get);

  const customer = { tags: ['orders'], auth: true } as const;
  docs.add({
    ...customer,
    method: 'post',
    path: `${basePath}${P.CHECKOUT}`,
    summary:
      'Place an order from my cart, split per seller; reserves stock and empties the cart. COD: placed at once. Kashier: awaiting payment for KASHIER_PAYMENT_TTL_MINUTES, with the payment page in kashier.checkoutUrl (null when Kashier failed; ask again through kashier-session) (CART_EMPTY 422, CART_HAS_ISSUES 409, ADDRESS_NOT_FOUND 422, GOVERNORATE_NOT_DELIVERABLE 422, ORDER_TOTAL_CHANGED 409, ORDER_PAYMENT_PENDING 409 (Kashier, an unpaid order exists), INSUFFICIENT_STOCK 409)',
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

  docs.add({
    ...customer,
    method: 'post',
    path: `${basePath}${P.CUSTOMER_CANCEL}`,
    summary:
      'Cancel one seller order of my order while it is placed; its stock is released (ORDER_NOT_FOUND, SELLER_ORDER_NOT_FOUND, SELLER_ORDER_NOT_CANCELLABLE 409)',
    requestBody: CancelSellerOrderDto,
    idempotent: true,
    responses: { 200: { description: 'The order after the change', body: OrderDetailDto } },
  });

  docs.add({
    ...customer,
    method: 'post',
    path: `${basePath}${P.KASHIER_SESSION}`,
    summary:
      'The Kashier payment page of my order while it awaits payment; the same session on every call (ORDER_NOT_FOUND 404, ORDER_NOT_AWAITING_PAYMENT 409, PAYMENT_PROVIDER_UNAVAILABLE 502)',
    responses: { 200: { description: 'The payment page', body: KashierSessionDto } },
  });

  const seller = { tags: ['seller: orders'], auth: true } as const;
  const sellerActions: [
    string,
    string,
    (typeof CancelSellerOrderDto | typeof CancelOrderItemDto)?,
    boolean?,
  ][] = [
    [
      P.SELLER_ACCEPT,
      'Accept a placed seller order, also after the deadline until the timeout job ran (SELLER_ORDER_INVALID_STATUS_TRANSITION 409)',
    ],
    [
      P.SELLER_READY,
      'Mark an accepted seller order ready for pickup; publishes seller_order.ready_for_pickup (SELLER_ORDER_INVALID_STATUS_TRANSITION 409)',
    ],
    [
      P.SELLER_CANCEL,
      'Cancel a seller order until it is picked up; its stock is released (SELLER_ORDER_NOT_CANCELLABLE 409)',
      CancelSellerOrderDto,
      true,
    ],
    [
      P.SELLER_ITEM_CANCEL,
      'Cancel quantities of one line; cancelling every open unit cancels the seller order (ORDER_ITEM_NOT_FOUND 404, SELLER_ORDER_NOT_CANCELLABLE 409, ITEM_CANCEL_QUANTITY_INVALID 422)',
      CancelOrderItemDto,
      true,
    ],
    [
      P.SELLER_RETURN_RECEIVED,
      'Confirm a returned parcel arrived; its stock is released (SELLER_ORDER_INVALID_STATUS_TRANSITION 409)',
      undefined,
      true,
    ],
  ];
  for (const [path, summary, requestBody, idempotent] of sellerActions) {
    docs.add({
      ...seller,
      method: 'post',
      path: `${basePath}${path}`,
      summary: `${summary} (SELLER_ORDER_NOT_FOUND 404)`,
      ...(requestBody ? { requestBody } : {}),
      idempotent: idempotent ?? false,
      responses: { 200: { description: 'The seller order after the change', body: SellerOrderDto } },
    });
  }
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
