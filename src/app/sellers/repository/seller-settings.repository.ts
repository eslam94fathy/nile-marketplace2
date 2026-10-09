import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Rate } from '../../../lib/money';
import { SELLERS_TABLES } from '../constants';

const T = SELLERS_TABLES.SELLER_SETTINGS;
const COLUMNS = ['default_commission_rate', 'updated_at'] as const;

interface SellerSettingsTable {
  id: string;
  is_singleton: boolean;
  default_commission_rate: string;
  created_at: Date;
  updated_at: Date;
}

export interface SellerSettings {
  defaultCommissionRate: Rate;
  updatedAt: Date;
}

const MISSING = 'seller_settings row is missing (it is seeded by migration)';

/** The single row, selected by `is_singleton` (seeded by the migration, never inserted by the app). */
@injectable()
export class SellerSettingsRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async get(trx?: DbTransaction): Promise<SellerSettings> {
    const row = await this.exec(trx)<SellerSettingsTable>(T)
      .select(...COLUMNS)
      .where({ is_singleton: true })
      .first();
    if (!row) throw new Error(MISSING);
    return { defaultCommissionRate: Rate.of(row.default_commission_rate), updatedAt: row.updated_at };
  }

  async updateDefaultCommissionRate(rate: Rate, trx?: DbTransaction): Promise<SellerSettings> {
    const executor = this.exec(trx);
    const [row] = await executor<SellerSettingsTable>(T)
      .where({ is_singleton: true })
      .update({ default_commission_rate: rate.toString(), updated_at: executor.fn.now() })
      .returning(COLUMNS);
    if (!row) throw new Error(MISSING);
    return { defaultCommissionRate: Rate.of(row.default_commission_rate), updatedAt: row.updated_at };
  }
}
