import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { CART_TABLES } from '../constants';
import { type CartItem } from '../model/cart-item.model';

const T = CART_TABLES.CART_ITEMS;
const COLUMNS = ['id', 'variant_id', 'quantity'] as const;

interface CartItemTable {
  id: string;
  cart_id: string;
  variant_id: string;
  quantity: number;
  created_at: Date;
  updated_at: Date;
}

type CartItemRow = Pick<CartItemTable, (typeof COLUMNS)[number]>;

function toModel(row: CartItemRow): CartItem {
  return { id: row.id, variantId: row.variant_id, quantity: row.quantity };
}

/** Every write runs under the cart row lock its caller took (spec 08 CT-2), so `trx` is required. */
@injectable()
export class CartItemRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** The cart's lines in the order they were added (spec 08 CT-6). */
  async listByCartId(cartId: string, trx?: DbTransaction): Promise<CartItem[]> {
    const rows = await this.exec(trx)<CartItemTable>(T)
      .select(...COLUMNS)
      .where({ cart_id: cartId })
      .orderBy([
        { column: 'created_at', order: 'asc' },
        { column: 'id', order: 'asc' },
      ]);
    return rows.map(toModel);
  }

  /** A line of this cart only, so another customer's line id is simply not found. */
  async findById(cartId: string, itemId: string, trx: DbTransaction): Promise<CartItem | null> {
    const row = await trx<CartItemTable>(T)
      .select(...COLUMNS)
      .where({ id: itemId, cart_id: cartId })
      .first<CartItemRow | undefined>();
    return row ? toModel(row) : null;
  }

  async findByVariantId(cartId: string, variantId: string, trx: DbTransaction): Promise<CartItem | null> {
    const row = await trx<CartItemTable>(T)
      .select(...COLUMNS)
      .where({ cart_id: cartId, variant_id: variantId })
      .first<CartItemRow | undefined>();
    return row ? toModel(row) : null;
  }

  async countByCartId(cartId: string, trx: DbTransaction): Promise<number> {
    const row = await trx<CartItemTable>(T)
      .where({ cart_id: cartId })
      .count<{ count: string | number }[]>({ count: '*' })
      .first();
    return Number(row?.count ?? 0);
  }

  async insert(cartId: string, variantId: string, quantity: number, trx: DbTransaction): Promise<CartItem> {
    const [row] = await trx<CartItemTable>(T)
      .insert({ cart_id: cartId, variant_id: variantId, quantity })
      .returning<CartItemRow[]>(COLUMNS);
    if (!row) throw new Error('cart_items insert returned no row');
    return toModel(row);
  }

  /** Returns the updated line, or null when the line isn't in this cart (zero rows updated). */
  async updateQuantity(
    cartId: string,
    itemId: string,
    quantity: number,
    trx: DbTransaction,
  ): Promise<CartItem | null> {
    const [row] = await trx<CartItemTable>(T)
      .update({ quantity, updated_at: trx.fn.now() })
      .where({ id: itemId, cart_id: cartId })
      .returning<CartItemRow[]>(COLUMNS);
    return row ? toModel(row) : null;
  }

  /** True when a line of this cart was deleted. */
  async delete(cartId: string, itemId: string, trx: DbTransaction): Promise<boolean> {
    const deleted = await trx<CartItemTable>(T).where({ id: itemId, cart_id: cartId }).delete();
    return deleted > 0;
  }

  async deleteByCartId(cartId: string, trx: DbTransaction): Promise<void> {
    await trx<CartItemTable>(T).where({ cart_id: cartId }).delete();
  }
}
