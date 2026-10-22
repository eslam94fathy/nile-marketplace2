import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { CUSTOMERS_TABLES } from '../constants';

const T = CUSTOMERS_TABLES.WISHLIST_ITEMS;

interface WishlistItemRow {
  id: string;
  customer_id: string;
  product_id: string;
  created_at: Date;
}

export interface WishlistItem {
  id: string;
  productId: string;
  addedAt: Date;
}

const toModel = (row: WishlistItemRow): WishlistItem => ({
  id: row.id,
  productId: row.product_id,
  addedAt: row.created_at,
});

/** All SQL of `wishlist_items` (spec 04 §8). */
@injectable()
export class WishlistRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /** Under the customer lock (UC-CU-3): the limit check counts on uq_wishlist_items_customer_id_product_id. */
  async count(customerId: string, trx: DbTransaction): Promise<number> {
    const row = await trx(T)
      .where({ customer_id: customerId })
      .first<{ count: string }>(trx.raw('count(*) AS count'));
    return Number(row?.count ?? 0);
  }

  async contains(customerId: string, productId: string, trx: DbTransaction): Promise<boolean> {
    const result = await trx.raw<{ rows: { exists: boolean }[] }>(
      `SELECT EXISTS (SELECT 1 FROM ${T} WHERE customer_id = ? AND product_id = ?) AS "exists"`,
      [customerId, productId],
    );
    return result.rows[0]?.exists ?? false;
  }

  /** Idempotent: a product already in the list stays as it was. */
  async add(customerId: string, productId: string, trx: DbTransaction): Promise<void> {
    await trx(T)
      .insert({ customer_id: customerId, product_id: productId })
      .onConflict(['customer_id', 'product_id'])
      .ignore();
  }

  /** Idempotent: removing what isn't there changes nothing (UC-CU-4). */
  async remove(customerId: string, productId: string): Promise<void> {
    await this.db.knex(T).where({ customer_id: customerId, product_id: productId }).delete();
  }

  /** GET /me/wishlist: idx_wishlist_items_customer_id_created_at_id. */
  async list(customerId: string, query: ParsedListQuery): Promise<WishlistItem[]> {
    const qb = this.db
      .knex<WishlistItemRow>(T)
      .select('id', 'customer_id', 'product_id', 'created_at')
      .where({ customer_id: customerId });
    const rows = (await applyListQuery(qb, query, 'id')) as WishlistItemRow[];
    return rows.map(toModel);
  }

  /** Every product id, newest first (WL-1); at most WISHLIST_MAX_ITEMS rows exist. */
  async productIds(customerId: string): Promise<string[]> {
    const rows = await this.db
      .knex<WishlistItemRow>(T)
      .select('product_id')
      .where({ customer_id: customerId })
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ]);
    return rows.map((row) => row.product_id);
  }
}
