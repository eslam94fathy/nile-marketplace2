import { inject, injectable } from 'tsyringe';
import { type ApiEnv } from '../../../lib/config';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ICatalogDirectory } from '../../catalog';
import { type IInventoryService, insufficientStock } from '../../inventory';
import { CART_MAX_LINE_QUANTITY } from '../constants';
import {
  cartItemNotFound,
  cartItemQuantityLimit,
  cartLineLimitReached,
  variantNotPurchasable,
} from '../errors';
import { CartItemRepository } from '../repository/cart-item.repository';
import { CartRepository } from '../repository/cart.repository';

type CartEnv = Pick<ApiEnv, 'CART_MAX_LINES'>;

/**
 * UC-CT-2: add / change / remove / empty. Every write locks the cart row first (CT-2), so the line
 * limit and the summed quantity can't race. Purchasability and stock are a soft check, read without
 * locks; checkout re-checks with a reservation.
 */
@injectable()
export class CartService {
  constructor(
    @inject(TOKENS.CartRepository) private readonly carts: CartRepository,
    @inject(TOKENS.CartItemRepository) private readonly items: CartItemRepository,
    @inject(TOKENS.CatalogDirectory) private readonly catalog: ICatalogDirectory,
    @inject(TOKENS.InventoryService) private readonly inventory: IInventoryService,
    @inject(TOKENS.TransactionRunner) private readonly transactions: ITransactionRunner,
    @inject(TOKENS.Env) private readonly env: CartEnv,
  ) {}

  /** Creates the cart on the first add. An existing line gets the quantity added to it (CT-4). */
  addItem(customerId: string, variantId: string, quantity: number): Promise<void> {
    return this.transactions.run(async (trx) => {
      const cartId = await this.carts.upsertAndLock(customerId, trx);
      await this.requirePurchasable(variantId, trx);
      const existing = await this.items.findByVariantId(cartId, variantId, trx);
      const resulting = (existing?.quantity ?? 0) + quantity;
      if (resulting > CART_MAX_LINE_QUANTITY) throw cartItemQuantityLimit(CART_MAX_LINE_QUANTITY);
      if (!existing && (await this.items.countByCartId(cartId, trx)) >= this.env.CART_MAX_LINES) {
        throw cartLineLimitReached(this.env.CART_MAX_LINES);
      }
      await this.requireStock(variantId, resulting, trx);
      if (existing) await this.items.updateQuantity(cartId, existing.id, resulting, trx);
      else await this.items.insert(cartId, variantId, resulting, trx);
    });
  }

  /** Sets the absolute quantity. A non-purchasable line fails even when decreasing (CT-4). */
  changeQuantity(customerId: string, itemId: string, quantity: number): Promise<void> {
    return this.transactions.run(async (trx) => {
      const cartId = await this.requireCart(customerId, trx);
      const item = await this.items.findById(cartId, itemId, trx);
      if (!item) throw cartItemNotFound();
      await this.requirePurchasable(item.variantId, trx);
      await this.requireStock(item.variantId, quantity, trx);
      if (!(await this.items.updateQuantity(cartId, itemId, quantity, trx))) throw cartItemNotFound();
    });
  }

  removeItem(customerId: string, itemId: string): Promise<void> {
    return this.transactions.run(async (trx) => {
      const cartId = await this.requireCart(customerId, trx);
      if (!(await this.items.delete(cartId, itemId, trx))) throw cartItemNotFound();
    });
  }

  /** Empties the cart; a no-op when there is none. The cart row stays. */
  clear(customerId: string): Promise<void> {
    return this.transactions.run(async (trx) => {
      const cartId = await this.carts.lockByCustomerId(customerId, trx);
      if (cartId !== null) await this.items.deleteByCartId(cartId, trx);
    });
  }

  /** Locks the cart without creating one: no cart means the line can't be the caller's. */
  private async requireCart(customerId: string, trx: DbTransaction): Promise<string> {
    const cartId = await this.carts.lockByCustomerId(customerId, trx);
    if (cartId === null) throw cartItemNotFound();
    return cartId;
  }

  /** Unknown ids are left out by catalog, so they fail the same way as hidden variants. */
  private async requirePurchasable(variantId: string, trx: DbTransaction): Promise<void> {
    const [variant] = await this.catalog.getVariantsForPurchase([variantId], trx);
    if (!variant?.purchasable) throw variantNotPurchasable();
  }

  private async requireStock(variantId: string, quantity: number, trx: DbTransaction): Promise<void> {
    const [level] = await this.inventory.getStockByVariantIds([variantId], trx);
    const available = level?.sellable ?? 0;
    if (available < quantity) throw insufficientStock([{ variantId, available }]);
  }
}
