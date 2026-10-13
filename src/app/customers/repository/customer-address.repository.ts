import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { CUSTOMERS_TABLES } from '../constants';
import { type AddressFields, CustomerAddress } from '../model/customer-address.model';

const T = CUSTOMERS_TABLES.CUSTOMER_ADDRESSES;
const COLUMNS = [
  'id',
  'customer_id',
  'governorate_id',
  'label',
  'recipient_name',
  'recipient_phone',
  'city',
  'area',
  'street',
  'building',
  'floor',
  'apartment',
  'landmark',
  'is_default',
  'created_at',
  'updated_at',
] as const;

interface AddressTable {
  id: string;
  customer_id: string;
  governorate_id: string;
  label: string;
  recipient_name: string;
  recipient_phone: string;
  city: string;
  area: string;
  street: string;
  building: string;
  floor: string | null;
  apartment: string | null;
  landmark: string | null;
  is_default: boolean;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type AddressRow = Pick<AddressTable, (typeof COLUMNS)[number]>;

/** camelCase field → column (the only place the mapping lives, CLAUDE.md §11). */
const FIELD_COLUMNS: Readonly<Record<keyof AddressFields, keyof AddressTable>> = {
  label: 'label',
  recipientName: 'recipient_name',
  recipientPhone: 'recipient_phone',
  governorateId: 'governorate_id',
  city: 'city',
  area: 'area',
  street: 'street',
  building: 'building',
  floor: 'floor',
  apartment: 'apartment',
  landmark: 'landmark',
};

function toModel(row: AddressRow): CustomerAddress {
  return new CustomerAddress({
    id: row.id,
    customerId: row.customer_id,
    governorateId: row.governorate_id,
    label: row.label,
    recipientName: row.recipient_name,
    recipientPhone: row.recipient_phone,
    city: row.city,
    area: row.area,
    street: row.street,
    building: row.building,
    floor: row.floor,
    apartment: row.apartment,
    landmark: row.landmark,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toColumns(fields: Partial<AddressFields>): Partial<AddressTable> {
  const columns: Partial<Record<keyof AddressTable, unknown>> = {};
  for (const [field, column] of Object.entries(FIELD_COLUMNS) as [
    keyof AddressFields,
    keyof AddressTable,
  ][]) {
    if (fields[field] !== undefined) columns[column] = fields[field];
  }
  return columns as Partial<AddressTable>;
}

/** Every read filters out soft-deleted rows (CLAUDE.md §6.2). */
@injectable()
export class CustomerAddressRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** Default first, then newest first (spec 04 §4.3). */
  async listByCustomer(customerId: string, trx?: DbTransaction): Promise<CustomerAddress[]> {
    const rows = await this.exec(trx)<AddressTable>(T)
      .select(...COLUMNS)
      .where({ customer_id: customerId })
      .whereNull('deleted_at')
      .orderBy([
        { column: 'is_default', order: 'desc' },
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ]);
    return rows.map(toModel);
  }

  /** Scoped to the customer, so another customer's address is simply not found (no IDOR). */
  async findById(customerId: string, id: string, trx?: DbTransaction): Promise<CustomerAddress | undefined> {
    const row = await this.exec(trx)<AddressTable>(T)
      .select(...COLUMNS)
      .where({ id, customer_id: customerId })
      .whereNull('deleted_at')
      .first();
    return row ? toModel(row) : undefined;
  }

  async countByCustomer(customerId: string, trx: DbTransaction): Promise<number> {
    const result = await trx.raw<{ rows: { count: number }[] }>(
      `SELECT count(*)::int AS count FROM ${T} WHERE customer_id = ? AND deleted_at IS NULL`,
      [customerId],
    );
    return result.rows[0]?.count ?? 0;
  }

  /** EXISTS check (G22). */
  async hasDefault(customerId: string, trx: DbTransaction): Promise<boolean> {
    const result = await trx.raw<{ rows: { exists: boolean }[] }>(
      `SELECT EXISTS (SELECT 1 FROM ${T} WHERE customer_id = ? AND is_default AND deleted_at IS NULL) AS "exists"`,
      [customerId],
    );
    return result.rows[0]?.exists === true;
  }

  async clearDefault(customerId: string, trx: DbTransaction): Promise<void> {
    await trx<AddressTable>(T)
      .where({ customer_id: customerId, is_default: true })
      .whereNull('deleted_at')
      .update({ is_default: false, updated_at: trx.fn.now() });
  }

  async insert(
    customerId: string,
    fields: AddressFields,
    isDefault: boolean,
    trx: DbTransaction,
  ): Promise<CustomerAddress> {
    const [row] = await trx<AddressTable>(T)
      .insert({ ...toColumns(fields), customer_id: customerId, is_default: isDefault })
      .returning(COLUMNS);
    if (!row) throw new Error('customer_addresses insert returned no row');
    return toModel(row);
  }

  /** Returns undefined if the address is missing, deleted or another customer's. */
  async update(
    customerId: string,
    id: string,
    changes: { fields: Partial<AddressFields>; isDefault?: boolean },
    trx: DbTransaction,
  ): Promise<CustomerAddress | undefined> {
    const [row] = await trx<AddressTable>(T)
      .where({ id, customer_id: customerId })
      .whereNull('deleted_at')
      .update({
        ...toColumns(changes.fields),
        ...(changes.isDefault !== undefined ? { is_default: changes.isDefault } : {}),
        updated_at: trx.fn.now(),
      })
      .returning(COLUMNS);
    return row ? toModel(row) : undefined;
  }

  /** Soft delete. False if the address is missing, already deleted or another customer's. */
  async softDelete(customerId: string, id: string, trx: DbTransaction): Promise<boolean> {
    const count = await trx<AddressTable>(T)
      .where({ id, customer_id: customerId })
      .whereNull('deleted_at')
      .update({ deleted_at: trx.fn.now(), updated_at: trx.fn.now() });
    return count === 1;
  }
}
