import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type CheckoutLine } from '../model/cart-item.model';
import { CartItemRepository } from '../repository/cart-item.repository';
import { CartRepository } from '../repository/cart.repository';

/** cart's public API (spec 08 §2), called by ordering inside its checkout transaction. */
export interface ICartDirectory {
  /**
   * Locks the customer's cart row (`FOR UPDATE`) so two checkouts of the same cart serialise, then
   * returns its lines in cart order. No cart → `[]`.
   */
  getLinesForCheckout(customerId: string, trx: DbTransaction): Promise<CheckoutLine[]>;
  /** Deletes every line of the customer's cart, inside the caller's transaction. */
  clear(customerId: string, trx: DbTransaction): Promise<void>;
}

@injectable()
export class CartDirectory implements ICartDirectory {
  constructor(
    @inject(TOKENS.CartRepository) private readonly carts: CartRepository,
    @inject(TOKENS.CartItemRepository) private readonly items: CartItemRepository,
  ) {}

  async getLinesForCheckout(customerId: string, trx: DbTransaction): Promise<CheckoutLine[]> {
    const cartId = await this.carts.lockByCustomerId(customerId, trx);
    if (cartId === null) return [];
    const lines = await this.items.listByCartId(cartId, trx);
    return lines.map(({ variantId, quantity }) => ({ variantId, quantity }));
  }

  async clear(customerId: string, trx: DbTransaction): Promise<void> {
    const cartId = await this.carts.lockByCustomerId(customerId, trx);
    if (cartId === null) return;
    await this.items.deleteByCartId(cartId, trx);
  }
}
