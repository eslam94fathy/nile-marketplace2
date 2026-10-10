import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { CATALOG_TABLES } from '../constants';
import { type CategoryAttribute } from '../model/category-tree.model';

const T = CATALOG_TABLES.CATEGORY_ATTRIBUTES;
const COLUMNS = ['id', 'category_id', 'name', 'code', 'sort_order'] as const;

interface CategoryAttributeTable {
  id: string;
  category_id: string;
  name: string;
  code: string;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

type AttributeRow = Pick<CategoryAttributeTable, (typeof COLUMNS)[number]>;

export type NewCategoryAttribute = Omit<CategoryAttribute, 'id'>;
export type CategoryAttributePatch = Partial<Pick<CategoryAttribute, 'name' | 'sortOrder'>>;

function toModel(row: AttributeRow): CategoryAttribute {
  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name,
    code: row.code,
    sortOrder: row.sort_order,
  };
}

@injectable()
export class CategoryAttributeRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** Loaded with the cached tree. */
  async findAll(trx?: DbTransaction): Promise<CategoryAttribute[]> {
    const rows = await this.exec(trx)<CategoryAttributeTable>(T).select(...COLUMNS);
    return rows.map(toModel);
  }

  /** `SELECT … FOR UPDATE`: serialises option writes of one attribute (the option limit). */
  async findForUpdate(id: string, trx: DbTransaction): Promise<CategoryAttribute | null> {
    const row = await trx<CategoryAttributeTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .forUpdate()
      .first<AttributeRow | undefined>();
    return row ? toModel(row) : null;
  }

  async insert(attribute: NewCategoryAttribute, trx: DbTransaction): Promise<string> {
    const [row] = await trx<CategoryAttributeTable>(T)
      .insert({
        category_id: attribute.categoryId,
        name: attribute.name,
        code: attribute.code,
        sort_order: attribute.sortOrder,
      })
      .returning<Pick<CategoryAttributeTable, 'id'>[]>('id');
    if (!row) throw new Error('category_attributes insert returned no row');
    return row.id;
  }

  async update(id: string, patch: CategoryAttributePatch, trx: DbTransaction): Promise<boolean> {
    const count = await trx<CategoryAttributeTable>(T)
      .where({ id })
      .update({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.sortOrder !== undefined && { sort_order: patch.sortOrder }),
        updated_at: trx.fn.now(),
      });
    return count > 0;
  }

  async delete(id: string, trx: DbTransaction): Promise<boolean> {
    return (await trx<CategoryAttributeTable>(T).where({ id }).delete()) > 0;
  }
}
