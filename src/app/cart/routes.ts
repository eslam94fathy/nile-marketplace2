import { Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, byUser, RateLimitClass, type RateLimiters, requireRole } from '../../lib/middleware';
import { CART_PATHS as P } from './constants';
import { type CartController } from './controller/cart.controller';
import { AddCartItemDto, CouponPreviewRequestDto, UpdateCartItemDto } from './dto/cart-request.dto';
import { CartDto, CouponQuoteDto } from './dto/cart-response.dto';

const TAGS = ['cart'] as const;

export interface CartRouteDeps {
  cart: CartController;
  jwtVerifier: JwtVerifier;
  rateLimiters: RateLimiters;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/** Spec 08 §4: customer only, the global general rate limit, no Idempotency-Key (CT-5). */
export function cartRoutes(deps: CartRouteDeps): Router {
  const { cart, docs, basePath } = deps;
  const router = Router();
  const customerOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.CUSTOMER)];

  router.get(P.CART, ...customerOnly, cart.get);
  router.delete(P.CART, ...customerOnly, cart.clear);
  router.post(P.ITEMS, ...customerOnly, cart.addItem);
  router.patch(P.ITEM, ...customerOnly, cart.updateItem);
  router.delete(P.ITEM, ...customerOnly, cart.removeItem);
  // PR-6: its own per-user class against guessing codes, on top of the general limit.
  router.post(
    P.COUPON_PREVIEW,
    ...customerOnly,
    deps.rateLimiters.limit(RateLimitClass.COUPON_PREVIEW, byUser),
    cart.couponPreview,
  );

  const mine = { tags: TAGS, auth: true } as const;
  docs.add({
    ...mine,
    method: 'get',
    path: `${basePath}${P.CART}`,
    summary:
      'My cart with live prices and stock, grouped by seller; lines with an issue are shown but left out of the totals',
    responses: { 200: { description: 'My cart (id null until the first add)', body: CartDto } },
  });
  docs.add({
    ...mine,
    method: 'post',
    path: `${basePath}${P.ITEMS}`,
    summary:
      'Add a variant; an existing line gets the quantity added to it (VARIANT_NOT_PURCHASABLE, INSUFFICIENT_STOCK, CART_ITEM_QUANTITY_LIMIT, CART_LINE_LIMIT_REACHED)',
    requestBody: AddCartItemDto,
    responses: { 201: { description: 'My cart after the add', body: CartDto } },
  });
  docs.add({
    ...mine,
    method: 'patch',
    path: `${basePath}${P.ITEM}`,
    summary:
      'Set the quantity of a line (CART_ITEM_NOT_FOUND, VARIANT_NOT_PURCHASABLE, INSUFFICIENT_STOCK); an unavailable line can only be removed',
    requestBody: UpdateCartItemDto,
    responses: { 200: { description: 'My cart after the change', body: CartDto } },
  });
  docs.add({
    ...mine,
    method: 'delete',
    path: `${basePath}${P.ITEM}`,
    summary: 'Remove a line (CART_ITEM_NOT_FOUND)',
    responses: { 204: { description: 'Removed' } },
  });
  docs.add({
    ...mine,
    method: 'delete',
    path: `${basePath}${P.CART}`,
    summary: 'Empty my cart',
    responses: { 204: { description: 'Emptied' } },
  });
  docs.add({
    ...mine,
    method: 'post',
    path: `${basePath}${P.COUPON_PREVIEW}`,
    summary:
      'What a coupon code would take off my cart (lines with an issue left out); nothing is stored, send the code again at checkout. 422: CART_EMPTY, COUPON_NOT_FOUND, COUPON_INACTIVE, COUPON_NOT_ACTIVE_YET, COUPON_EXPIRED, COUPON_LIMIT_REACHED, COUPON_CUSTOMER_LIMIT_REACHED, COUPON_NOT_APPLICABLE, COUPON_MIN_SUBTOTAL_NOT_MET (details: the missing amount). Rate class coupon-preview (429)',
    requestBody: CouponPreviewRequestDto,
    responses: { 200: { description: 'The discount per seller and line', body: CouponQuoteDto } },
  });

  return router;
}
