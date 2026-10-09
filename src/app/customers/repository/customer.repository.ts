import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { CUSTOMERS_TABLES } from '../constants';
import { Customer } from '../model/customer.model';

const T = CUSTOMERS_TABLES.CUSTOMERS;
const COLUMNS = ['id', 'user_id', 'first_name', 'last_name', 'phone', 'created_at', 'updated_at'] as const;

interface CustomerRow {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  phone: string;
  created_at: Date;
  updated_at: Date;
}

export interface NewCustomer {
  userId: string;
  firstName: string;
  lastName: string;
  phone: string;
}

export type CustomerPatch = Partial<Pick<NewCustomer, 'firstName' | 'lastName' | 'phone'>>;

function toModel(row: CustomerRow): Customer {
  return new Customer({
    id: row.id,
    userId: row.user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

@injectable()
export class CustomerRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async findByUserId(userId: string, trx?: DbTransaction): Promise<Customer | undefined> {
    const row = await this.exec(trx)<CustomerRow>(T)
      .select(...COLUMNS)
      .where({ user_id: userId })
      .first();
    return row ? toModel(row) : undefined;
  }

  /**
   * Serialises every address write of one customer (spec 04 C-2): the limit count, the default rule
   * and clearing the old default all run after this lock, so concurrent requests can't race.
   */
  async lockById(id: string, trx: DbTransaction): Promise<boolean> {
    const row = await trx<CustomerRow>(T).select('id').where({ id }).forUpdate().first();
    return row !== undefined;
  }

  async insert(customer: NewCustomer, trx: DbTransaction): Promise<Customer> {
    const [row] = await trx<CustomerRow>(T)
      .insert({
        user_id: customer.userId,
        first_name: customer.firstName,
        last_name: customer.lastName,
        phone: customer.phone,
      })
      .returning(COLUMNS);
    if (!row) throw new Error('customers insert returned no row');
    return toModel(row);
  }

  /** Returns undefined if the customer doesn't exist. `patch` has at least one field (PATCH DTO). */
  async update(id: string, patch: CustomerPatch, trx?: DbTransaction): Promise<Customer | undefined> {
    const executor = this.exec(trx);
    const [row] = await executor<CustomerRow>(T)
      .where({ id })
      .update({
        ...(patch.firstName !== undefined ? { first_name: patch.firstName } : {}),
        ...(patch.lastName !== undefined ? { last_name: patch.lastName } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        updated_at: executor.fn.now(),
      })
      .returning(COLUMNS);
    return row ? toModel(row) : undefined;
  }
}
