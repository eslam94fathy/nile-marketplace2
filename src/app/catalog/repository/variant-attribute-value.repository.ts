import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { CATALOG_TABLES } from '../constants';
import { type VariantOptionValue } from '../model/product-variant.model';

const T = CATALOG_TABLES.VARIANT_ATTRIBUTE_VALUES;
const ATTRIBUTES = CATALOG_TABLES.CATEGORY_ATTRIBUTES;
const OPTIONS = CATALOG_TABLES.CATEGORY_ATTRIBUTE_OPTIONS;

interface VariantAttributeValueTable {
  variant_id: string;
  attribute_id: string;
  option_id: string;
}

interface VariantOptionRow {
  variant_id: string;
  attribute_id: string;
  attribute_code: string;
  option_id: string;
  option_code: string;
  value: string;
}

/** The option a variant has per attribute (composite PK, SD-8). */
@injectable()
export class VariantAttributeValueRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** One multi-row insert (CLAUDE.md §6.4). */
  async insertMany(
    variantId: string,
    values: readonly { attributeId: string; optionId: string }[],
    trx: DbTransaction,
  ): Promise<void> {
    if (values.length === 0) return;
    await trx<VariantAttributeValueTable>(T).insert(
      values.map((v) => ({ variant_id: variantId, attribute_id: v.attributeId, option_id: v.optionId })),
    );
  }

  /**
   * Options of these variants with display data: one batched query, joined within catalog's own
   * tables (pk_variant_attribute_values serves `variant_id IN (...)`). Ordered by attribute.
   */
  async findByVariantIds(
    variantIds: readonly string[],
    trx?: DbTransaction,
  ): Promise<Map<string, VariantOptionValue[]>> {
    const byVariant = new Map<string, VariantOptionValue[]>();
    if (variantIds.length === 0) return byVariant;
    const rows = await this.exec(trx)(`${T} as v`)
      .join(`${ATTRIBUTES} as a`, 'a.id', 'v.attribute_id')
      .join(`${OPTIONS} as o`, 'o.id', 'v.option_id')
      .whereIn('v.variant_id', [...new Set(variantIds)])
      .orderBy([
        { column: 'a.sort_order', order: 'asc' },
        { column: 'a.code', order: 'asc' },
      ])
      .select<VariantOptionRow[]>(
        'v.variant_id',
        'v.attribute_id',
        'a.code as attribute_code',
        'v.option_id',
        'o.code as option_code',
        'o.value',
      );
    for (const row of rows) {
      const list = byVariant.get(row.variant_id) ?? [];
      list.push({
        attributeId: row.attribute_id,
        attributeCode: row.attribute_code,
        optionId: row.option_id,
        optionCode: row.option_code,
        value: row.value,
      });
      byVariant.set(row.variant_id, list);
    }
    return byVariant;
  }

  /** EXISTS check (G22) over idx_variant_attribute_values_option_id_variant_id; deleted variants count. */
  async isOptionUsed(optionId: string, trx?: DbTransaction): Promise<boolean> {
    const result = await this.exec(trx).raw<{ rows: { exists: boolean }[] }>(
      `SELECT EXISTS (SELECT 1 FROM ${T} WHERE option_id = ?) AS "exists"`,
      [optionId],
    );
    return result.rows[0]?.exists ?? false;
  }
}
