import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { CATALOG_TABLES } from '../constants';
import { type CategoryAttributeOption } from '../model/category-tree.model';

const T = CATALOG_TABLES.CATEGORY_ATTRIBUTE_OPTIONS;
const COLUMNS = ['id', 'attribute_id', 'value', 'code', 'sort_order'] as const;

interface CategoryAttributeOptionTable {
  id: string;
  attribute_id: string;
  value: string;
  code: string;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

type OptionRow = Pick<CategoryAttributeOptionTable, (typeof COLUMNS)[number]>;

export type NewCategoryAttributeOption = Omit<CategoryAttributeOption, 'id'>;
export type CategoryAttributeOptionPatch = Partial<Pick<CategoryAttributeOption, 'value' | 'sortOrder'>>;

function toModel(row: OptionRow): CategoryAttributeOption {
  return {
    id: row.id,
    attributeId: row.attribute_id,
    value: row.value,
    code: row.code,
    sortOrder: row.sort_order,
  };
}

@injectable()
export class CategoryAttributeOptionRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** Loaded with the cached tree. */
  async findAll(trx?: DbTransaction): Promise<CategoryAttributeOption[]> {
    const rows = await this.exec(trx)<CategoryAttributeOptionTable>(T).select(...COLUMNS);
    return rows.map(toModel);
  }

  async findById(id: string, trx?: DbTransaction): Promise<CategoryAttributeOption | null> {
    const row = await this.exec(trx)<CategoryAttributeOptionTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .first<OptionRow | undefined>();
    return row ? toModel(row) : null;
  }

  /** Batched by primary key; unknown ids are left out. */
  async findByIds(ids: readonly string[], trx?: DbTransaction): Promise<CategoryAttributeOption[]> {
    if (ids.length === 0) return [];
    const rows = await this.exec(trx)<CategoryAttributeOptionTable>(T)
      .select(...COLUMNS)
      .whereIn('id', [...new Set(ids)]);
    return rows.map(toModel);
  }

  /** Served by uq_category_attribute_options_attribute_id_code (attribute_id leads). */
  async countByAttribute(attributeId: string, trx: DbTransaction): Promise<number> {
    const row = await trx<CategoryAttributeOptionTable>(T)
      .where({ attribute_id: attributeId })
      .count<{ count: string }[]>({ count: '*' })
      .first();
    return Number(row?.count ?? 0);
  }

  async insert(option: NewCategoryAttributeOption, trx: DbTransaction): Promise<string> {
    const [row] = await trx<CategoryAttributeOptionTable>(T)
      .insert({
        attribute_id: option.attributeId,
        value: option.value,
        code: option.code,
        sort_order: option.sortOrder,
      })
      .returning<Pick<CategoryAttributeOptionTable, 'id'>[]>('id');
    if (!row) throw new Error('category_attribute_options insert returned no row');
    return row.id;
  }

  async update(id: string, patch: CategoryAttributeOptionPatch, trx: DbTransaction): Promise<boolean> {
    const count = await trx<CategoryAttributeOptionTable>(T)
      .where({ id })
      .update({
        ...(patch.value !== undefined && { value: patch.value }),
        ...(patch.sortOrder !== undefined && { sort_order: patch.sortOrder }),
        updated_at: trx.fn.now(),
      });
    return count > 0;
  }

  async delete(id: string, trx: DbTransaction): Promise<boolean> {
    return (await trx<CategoryAttributeOptionTable>(T).where({ id }).delete()) > 0;
  }

  /** Explicit delete before the attribute itself (no CASCADE, spec 06 CA-11). */
  async deleteByAttribute(attributeId: string, trx: DbTransaction): Promise<void> {
    await trx<CategoryAttributeOptionTable>(T).where({ attribute_id: attributeId }).delete();
  }
}
