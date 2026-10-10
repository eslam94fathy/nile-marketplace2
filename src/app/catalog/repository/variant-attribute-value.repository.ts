import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { CATALOG_TABLES } from '../constants';

const T = CATALOG_TABLES.VARIANT_ATTRIBUTE_VALUES;

/** The option a variant has per attribute. Variant writes land in P3 step 5. */
@injectable()
export class VariantAttributeValueRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /** EXISTS check (G22) over idx_variant_attribute_values_option_id_variant_id; deleted variants count. */
  async isOptionUsed(optionId: string, trx?: DbTransaction): Promise<boolean> {
    const db = trx ?? this.db.knex;
    const result = await db.raw<{ rows: { exists: boolean }[] }>(
      `SELECT EXISTS (SELECT 1 FROM ${T} WHERE option_id = ?) AS "exists"`,
      [optionId],
    );
    return result.rows[0]?.exists ?? false;
  }
}
