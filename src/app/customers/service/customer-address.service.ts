import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { addressLimitReached, addressNotFound, defaultAddressUnsetNotAllowed } from '../errors';
import { type AddressFields, type CustomerAddress } from '../model/customer-address.model';
import { type CustomerAddressRepository } from '../repository/customer-address.repository';
import { type CustomerRepository } from '../repository/customer.repository';

type AddressEnv = Pick<Env, 'CUSTOMER_MAX_ADDRESSES'>;

/**
 * Address book (spec 04 UC-CU-2). Every write locks the customer row first (C-2), so the limit, the
 * default rule (C-3) and the one-default index can't race. GOVERNORATE_NOT_FOUND comes from the FK.
 */
@injectable()
export class CustomerAddressService {
  constructor(
    @inject(TOKENS.CustomerRepository) private readonly customers: CustomerRepository,
    @inject(TOKENS.CustomerAddressRepository) private readonly addresses: CustomerAddressRepository,
    @inject(TOKENS.TransactionRunner) private readonly transactions: ITransactionRunner,
    @inject(TOKENS.Env) private readonly env: AddressEnv,
  ) {}

  list(customerId: string): Promise<CustomerAddress[]> {
    return this.addresses.listByCustomer(customerId);
  }

  async get(customerId: string, addressId: string, trx?: DbTransaction): Promise<CustomerAddress> {
    const address = await this.addresses.findById(customerId, addressId, trx);
    if (!address) throw addressNotFound();
    return address;
  }

  /** The new address becomes the default when asked, or whenever there is no live default (C-3). */
  create(customerId: string, fields: AddressFields, isDefault: boolean): Promise<CustomerAddress> {
    return this.transactions.run(async (trx) => {
      await this.lockCustomer(customerId, trx);
      const max = this.env.CUSTOMER_MAX_ADDRESSES;
      if ((await this.addresses.countByCustomer(customerId, trx)) >= max) throw addressLimitReached(max);
      const hasDefault = await this.addresses.hasDefault(customerId, trx);
      if (isDefault && hasDefault) await this.addresses.clearDefault(customerId, trx);
      return this.addresses.insert(customerId, fields, isDefault || !hasDefault, trx);
    });
  }

  /** `isDefault: true` moves the default here; `false` on the default is refused (spec 04 §4.3). */
  update(
    customerId: string,
    addressId: string,
    changes: { fields: Partial<AddressFields>; isDefault?: boolean },
  ): Promise<CustomerAddress> {
    return this.transactions.run(async (trx) => {
      await this.lockCustomer(customerId, trx);
      const current = await this.get(customerId, addressId, trx);
      if (changes.isDefault === false && current.isDefault) throw defaultAddressUnsetNotAllowed();
      const becomesDefault = changes.isDefault === true && !current.isDefault;
      if (becomesDefault) await this.addresses.clearDefault(customerId, trx);
      const updated = await this.addresses.update(
        customerId,
        addressId,
        { fields: changes.fields, ...(becomesDefault ? { isDefault: true } : {}) },
        trx,
      );
      if (!updated) throw addressNotFound();
      return updated;
    });
  }

  /** Soft delete. Deleting the default leaves none: nothing is promoted (UC-CU-2). */
  delete(customerId: string, addressId: string): Promise<void> {
    return this.transactions.run(async (trx) => {
      await this.lockCustomer(customerId, trx);
      if (!(await this.addresses.softDelete(customerId, addressId, trx))) throw addressNotFound();
    });
  }

  private async lockCustomer(customerId: string, trx: DbTransaction): Promise<void> {
    // The id comes from the caller's own profile, so it always exists.
    if (!(await this.customers.lockById(customerId, trx)))
      throw new Error(`customer ${customerId} is missing`);
  }
}
