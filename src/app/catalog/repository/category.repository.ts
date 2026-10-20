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
  image_media_id: string | null;
  image_alt_text: string | null;
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

  /** The categories that have an image (spec 06 §8.1). */
  async findImages(
    trx?: DbTransaction,
  ): Promise<{ categoryId: string; mediaId: string; altText: string | null }[]> {
    const rows = await this.exec(trx)<CategoryTable>(T)
      .select('id', 'image_media_id', 'image_alt_text')
      .whereNotNull('image_media_id');
    return rows.flatMap((row) =>
      row.image_media_id
        ? [{ categoryId: row.id, mediaId: row.image_media_id, altText: row.image_alt_text }]
        : [],
    );
  }

  /** One category's image, `null` when it has none (or doesn't exist). */
  async findImage(
    id: string,
    trx: DbTransaction,
  ): Promise<{ categoryId: string; mediaId: string; altText: string | null } | null> {
    const row = await trx<CategoryTable>(T)
      .select('id', 'image_media_id', 'image_alt_text')
      .where({ id })
      .first();
    return row?.image_media_id
      ? { categoryId: row.id, mediaId: row.image_media_id, altText: row.image_alt_text }
      : null;
  }

  /** Sets or clears (`null`) the image; the alt text goes with it. */
  async setImage(
    id: string,
    mediaId: string | null,
    altText: string | null,
    trx: DbTransaction,
  ): Promise<void> {
    await trx<CategoryTable>(T)
      .where({ id })
      .update({ image_media_id: mediaId, image_alt_text: altText, updated_at: trx.fn.now() });
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

  /**
   * `SELECT … FOR SHARE`: a product write holds its category so that a concurrent deactivation or
   * attribute change (which lock it `FOR UPDATE`) waits for it, and then sees the product.
   */
  async findForShare(id: string, trx: DbTransaction): Promise<Category | null> {
    const row = await trx<CategoryTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .forShare()
      .first<CategoryRow | undefined>();
    return row ? toModel(row) : null;
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
