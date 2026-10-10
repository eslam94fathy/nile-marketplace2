import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { CATALOG_TABLES } from '../constants';

const T = CATALOG_TABLES.PRODUCTS;

/** Products. The admin taxonomy checks use it now; seller writes and public reads land in P3 steps 5–6. */
@injectable()
export class ProductRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /**
   * EXISTS check (G22) over idx_products_category_id (D-7). `includeDeleted`: attribute deletes
   * count soft-deleted products too, because their variants still reference the attribute.
   */
  async existsInCategories(
    categoryIds: readonly string[],
    options: { includeDeleted: boolean },
    trx?: DbTransaction,
  ): Promise<boolean> {
    if (categoryIds.length === 0) return false;
    const db = trx ?? this.db.knex;
    const result = await db.raw<{ rows: { exists: boolean }[] }>(
      `SELECT EXISTS (
         SELECT 1 FROM ${T} WHERE category_id = ANY(?::uuid[])${options.includeDeleted ? '' : ' AND deleted_at IS NULL'}
       ) AS "exists"`,
      [[...new Set(categoryIds)]],
    );
    return result.rows[0]?.exists ?? false;
  }
}
