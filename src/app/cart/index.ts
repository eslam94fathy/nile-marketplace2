/**
 * cart module (docs/spec/08-cart.md): one cart per customer, with live prices, stock and issues.
 * Owns tables: carts, cart_items. No other module reads or writes them.
 * May call: customers, catalog, inventory, sellers. This file is its only public surface.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { TOKENS } from '../../lib/di';
import { type OpenApiRegistry } from '../../lib/http';
import { CartController } from './controller/cart.controller';
import { CartItemRepository } from './repository/cart-item.repository';
import { CartRepository } from './repository/cart.repository';
import { cartRoutes } from './routes';
import { CartDirectory } from './service/cart-directory.service';
import { CartViewService } from './service/cart-view.service';
import { CartService } from './service/cart.service';

export { CartErrorCode } from './errors';
export type { CheckoutLine } from './model/cart-item.model';
/** Inject with `TOKENS.CartDirectory`. */
export type { ICartDirectory } from './service/cart-directory.service';

/** api process. Needs customers, catalog, inventory and sellers registered first. */
export function registerCartModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.CartRepository, CartRepository);
  container.registerSingleton(TOKENS.CartItemRepository, CartItemRepository);
  container.registerSingleton(TOKENS.CartDirectory, CartDirectory);
  container.registerSingleton(TOKENS.CartService, CartService);
  container.registerSingleton(TOKENS.CartViewService, CartViewService);
  container.registerSingleton(TOKENS.CartController, CartController);
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createCartRouter(container: DependencyContainer, basePath: string): Router {
  return cartRoutes({
    cart: container.resolve<CartController>(TOKENS.CartController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
