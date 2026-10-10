import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { CATALOG_TABLES } from '../constants';
import { type Category } from '../model/category-tree.model';

const T = CATALOG_TABLES.CATEGORIES;
const COLUMNS = ['id', 'parent_id', 'name', 'slug', 'depth', 'sort_order', 'is_active'] as const;

interface CategoryTable {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  depth: number;
  sort_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

type CategoryRow = Pick<CategoryTable, (typeof COLUMNS)[number]>;

export type NewCategory = Omit<Category, 'id'>;
export type CategoryPatch = Partial<Pick<Category, 'name' | 'slug' | 'sortOrder' | 'isActive'>>;

function toModel(row: CategoryRow): Category {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    slug: row.slug,
    depth: row.depth,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

@injectable()
export class CategoryRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** The whole tree (hundreds of rows): no index needed (02-database.md §5). */
  async findAll(trx?: DbTransaction): Promise<Category[]> {
    const rows = await this.exec(trx)<CategoryTable>(T).select(...COLUMNS);
    return rows.map(toModel);
  }

  /**
   * `SELECT … FOR UPDATE` on these categories, in id order so overlapping lock sets never
   * deadlock (spec 06 CA-2). Returns the ids that exist.
   */
  async lockForUpdate(ids: readonly string[], trx: DbTransaction): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await trx<CategoryTable>(T)
      .select('id')
      .whereIn('id', [...new Set(ids)])
      .orderBy('id')
      .forUpdate();
    return rows.map((row) => row.id);
  }

  async insert(category: NewCategory, trx: DbTransaction): Promise<string> {
    const [row] = await trx<CategoryTable>(T)
      .insert({
        parent_id: category.parentId,
        name: category.name,
        slug: category.slug,
        depth: category.depth,
        sort_order: category.sortOrder,
        is_active: category.isActive,
      })
      .returning<Pick<CategoryTable, 'id'>[]>('id');
    if (!row) throw new Error('categories insert returned no row');
    return row.id;
  }

  /** Returns false when the row doesn't exist. */
  async update(id: string, patch: CategoryPatch, trx: DbTransaction): Promise<boolean> {
    const count = await trx<CategoryTable>(T)
      .where({ id })
      .update({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.slug !== undefined && { slug: patch.slug }),
        ...(patch.sortOrder !== undefined && { sort_order: patch.sortOrder }),
        ...(patch.isActive !== undefined && { is_active: patch.isActive }),
        updated_at: trx.fn.now(),
      });
    return count > 0;
  }
}
