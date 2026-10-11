import { Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { CART_PATHS as P } from './constants';
import { type CartController } from './controller/cart.controller';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart-request.dto';
import { CartDto } from './dto/cart-response.dto';

const TAGS = ['cart'] as const;

export interface CartRouteDeps {
  cart: CartController;
  jwtVerifier: JwtVerifier;
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

  return router;
}
