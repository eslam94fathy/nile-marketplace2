/**
 * cart module (docs/spec/08-cart.md): one cart per customer, with live prices, stock and issues.
 * Owns tables: carts, cart_items. No other module reads or writes them.
 * May call: customers, catalog, inventory, sellers. This file is its only public surface.
 */
import { type DependencyContainer } from 'tsyringe';
import { TOKENS } from '../../lib/di';
import { CartItemRepository } from './repository/cart-item.repository';
import { CartRepository } from './repository/cart.repository';
import { CartDirectory } from './service/cart-directory.service';

export type { CheckoutLine } from './model/cart-item.model';
/** Inject with `TOKENS.CartDirectory`. */
export type { ICartDirectory } from './service/cart-directory.service';

/** api process. Needs customers, catalog, inventory and sellers registered first. */
export function registerCartModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.CartRepository, CartRepository);
  container.registerSingleton(TOKENS.CartItemRepository, CartItemRepository);
  container.registerSingleton(TOKENS.CartDirectory, CartDirectory);
}
