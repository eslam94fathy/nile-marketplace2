import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import { DELIVERY_TABLES } from '../constants';
import { Governorate } from '../model/governorate.model';

const T = DELIVERY_TABLES.GOVERNORATES;
const COLUMNS = ['id', 'code', 'name', 'delivery_fee'] as const;

interface GovernorateTable {
  id: string;
  code: string;
  name: string;
  /** NUMERIC comes back from pg as a string. */
  delivery_fee: string | null;
  created_at: Date;
  updated_at: Date;
}

type GovernorateRow = Pick<GovernorateTable, (typeof COLUMNS)[number]>;

function toModel(row: GovernorateRow): Governorate {
  return new Governorate({
    id: row.id,
    code: row.code,
    name: row.name,
    deliveryFee: row.delivery_fee === null ? null : Money.of(row.delivery_fee),
  });
}

@injectable()
export class GovernorateRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** The whole table (27 rows), ordered by name: it is read at once and cached (architecture §8). */
  async findAll(trx?: DbTransaction): Promise<Governorate[]> {
    const rows = await this.exec(trx)<GovernorateTable>(T)
      .select(...COLUMNS)
      .orderBy([{ column: 'name' }, { column: 'id' }]);
    return rows.map(toModel);
  }

  /** Returns the updated governorate, or undefined if the id doesn't exist. */
  async updateDeliveryFee(
    id: string,
    deliveryFee: Money | null,
    trx?: DbTransaction,
  ): Promise<Governorate | undefined> {
    const executor = this.exec(trx);
    const [row] = await executor<GovernorateTable>(T)
      .where({ id })
      .update({ delivery_fee: deliveryFee?.toString() ?? null, updated_at: executor.fn.now() })
      .returning(COLUMNS);
    return row ? toModel(row) : undefined;
  }
}
