import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type AddressSnapshot } from '../model/customer-address.model';
import { type CustomerRepository } from '../repository/customer.repository';
import { type CustomerAddressService } from './customer-address.service';

/** Public API of customers (spec 04 §2), used by cart and ordering. */
export interface ICustomerDirectory {
  /** Resolves the profile from the JWT `sub`. */
  getCustomerIdByUserId(userId: string): Promise<string | null>;
  /** Checkout copy of an address. ADDRESS_NOT_FOUND if missing, deleted or another customer's. */
  getAddressSnapshot(customerId: string, addressId: string, trx?: DbTransaction): Promise<AddressSnapshot>;
}

@injectable()
export class CustomerDirectory implements ICustomerDirectory {
  constructor(
    @inject(TOKENS.CustomerRepository) private readonly customers: CustomerRepository,
    @inject(TOKENS.CustomerAddressService) private readonly addresses: CustomerAddressService,
  ) {}

  async getCustomerIdByUserId(userId: string): Promise<string | null> {
    return (await this.customers.findByUserId(userId))?.id ?? null;
  }

  async getAddressSnapshot(
    customerId: string,
    addressId: string,
    trx?: DbTransaction,
  ): Promise<AddressSnapshot> {
    return (await this.addresses.get(customerId, addressId, trx)).toSnapshot();
  }
}
