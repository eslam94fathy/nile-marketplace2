import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { CART_TABLES } from '../constants';

const T = CART_TABLES.CARTS;

interface CartTable {
  id: string;
  customer_id: string;
  created_at: Date;
  updated_at: Date;
}

type CartIdRow = Pick<CartTable, 'id'>;

@injectable()
export class CartRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /**
   * Creates the customer's cart if needed and locks its row, in one statement (spec 08 CT-2):
   * `ON CONFLICT … DO UPDATE` takes the row lock on an existing cart, the insert holds it on a new one,
   * and two parallel first adds end with one cart.
   */
  async upsertAndLock(customerId: string, trx: DbTransaction): Promise<string> {
    const [row] = await trx<CartTable>(T)
      .insert({ customer_id: customerId })
      .onConflict('customer_id')
      .merge({ updated_at: trx.fn.now() })
      .returning<CartIdRow[]>('id');
    if (!row) throw new Error('carts upsert returned no row');
    return row.id;
  }

  /** Locks the customer's cart row (`FOR UPDATE`) without creating one; null when there is none. */
  async lockByCustomerId(customerId: string, trx: DbTransaction): Promise<string | null> {
    const row = await trx<CartTable>(T)
      .select('id')
      .where({ customer_id: customerId })
      .forUpdate()
      .first<CartIdRow | undefined>();
    return row?.id ?? null;
  }

  async findIdByCustomerId(customerId: string, trx?: DbTransaction): Promise<string | null> {
    const row = await this.exec(trx)<CartTable>(T)
      .select('id')
      .where({ customer_id: customerId })
      .first<CartIdRow | undefined>();
    return row?.id ?? null;
  }
}
