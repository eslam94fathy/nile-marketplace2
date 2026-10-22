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
  /** Recipient resolution for realtime and notifications (spec 04 §8.3); unknown ids are left out. */
  getUserIds(customerIds: readonly string[]): Promise<Map<string, string>>;
  /** "Mona A." (first name + last initial), the reviewer name (spec 04 §8.3, RV-6); unknown ids are left out. */
  getDisplayNames(customerIds: readonly string[]): Promise<Map<string, string>>;
  /** "First Last" by user id, for support's admin views (spec 04 §8.7); unknown ids are left out. */
  getFullNamesByUserIds(userIds: readonly string[]): Promise<Map<string, string>>;
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

  getUserIds(customerIds: readonly string[]): Promise<Map<string, string>> {
    return this.customers.findUserIds(customerIds);
  }

  async getDisplayNames(customerIds: readonly string[]): Promise<Map<string, string>> {
    const customers = await this.customers.findByIds(customerIds);
    return new Map(customers.map((c) => [c.id, displayNameOf(c.firstName, c.lastName)]));
  }

  async getFullNamesByUserIds(userIds: readonly string[]): Promise<Map<string, string>> {
    const customers = await this.customers.findByUserIds(userIds);
    return new Map(customers.map((c) => [c.userId, `${c.firstName} ${c.lastName}`]));
  }
}

/**
 * First name and the last name's first character, upper-cased, with a dot (RV-6). By code point, so a
 * name starting with a character outside the BMP keeps it whole.
 */
export function displayNameOf(firstName: string, lastName: string): string {
  const [initial] = [...lastName.trim()];
  return initial ? `${firstName.trim()} ${initial.toLocaleUpperCase()}.` : firstName.trim();
}
