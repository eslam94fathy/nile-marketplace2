import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Rate } from '../../../lib/money';
import { DELIVERY_TABLES } from '../constants';
import { DeliverySettings } from '../model/delivery-settings.model';

const T = DELIVERY_TABLES.DELIVERY_SETTINGS;
const COLUMNS = ['agent_fee_share_rate', 'updated_at'] as const;

interface DeliverySettingsTable {
  id: string;
  is_singleton: boolean;
  agent_fee_share_rate: string;
  created_at: Date;
  updated_at: Date;
}

type DeliverySettingsRow = Pick<DeliverySettingsTable, (typeof COLUMNS)[number]>;

function toModel(row: DeliverySettingsRow): DeliverySettings {
  return new DeliverySettings({
    agentFeeShareRate: Rate.of(row.agent_fee_share_rate),
    updatedAt: row.updated_at,
  });
}

/** The single row, selected by `is_singleton` (seeded by the migration, never inserted by the app). */
@injectable()
export class DeliverySettingsRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async get(trx?: DbTransaction): Promise<DeliverySettings> {
    const row = await this.exec(trx)<DeliverySettingsTable>(T)
      .select(...COLUMNS)
      .where({ is_singleton: true })
      .first();
    if (!row) throw new Error('delivery_settings row is missing (it is seeded by migration)');
    return toModel(row);
  }

  async updateAgentFeeShareRate(rate: Rate, trx?: DbTransaction): Promise<DeliverySettings> {
    const executor = this.exec(trx);
    const [row] = await executor<DeliverySettingsTable>(T)
      .where({ is_singleton: true })
      .update({ agent_fee_share_rate: rate.toString(), updated_at: executor.fn.now() })
      .returning(COLUMNS);
    if (!row) throw new Error('delivery_settings row is missing (it is seeded by migration)');
    return toModel(row);
  }
}
