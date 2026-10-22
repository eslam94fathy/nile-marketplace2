import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type IAccountService, type UserSummary } from '../../identity';
import { customerNotFound } from '../errors';
import { type Customer } from '../model/customer.model';
import { type CustomerAddressRepository } from '../repository/customer-address.repository';
import { type CustomerRepository } from '../repository/customer.repository';

export interface AdminCustomer {
  customer: Customer;
  user: UserSummary;
}

/** The admin customer directory (spec 20 §3.3). Reads only, so nothing is audited (BO-3). */
@injectable()
export class CustomerAdminService {
  constructor(
    @inject(TOKENS.CustomerRepository) private readonly customers: CustomerRepository,
    @inject(TOKENS.CustomerAddressRepository) private readonly addresses: CustomerAddressRepository,
    @inject(TOKENS.AccountService) private readonly accounts: IAccountService,
  ) {}

  async list(query: ParsedListQuery): Promise<{ items: AdminCustomer[]; meta: PageMeta }> {
    const page = toPage(await this.customers.list(query), query, (customer) => customer.createdAt);
    return { items: await this.withUsers(page.items), meta: page.meta };
  }

  async detail(customerId: string): Promise<AdminCustomer & { addressCount: number }> {
    const [customer] = await this.customers.findByIds([customerId]);
    if (!customer) throw customerNotFound();
    const [[withUser], addressCount] = await Promise.all([
      this.withUsers([customer]),
      this.addresses.countByCustomer(customer.id),
    ]);
    if (!withUser) throw new Error('customer detail lost its row');
    return { ...withUser, addressCount };
  }

  /** Emails and statuses from one batched identity call (spec 20 §3.3, G20). */
  private async withUsers(customers: Customer[]): Promise<AdminCustomer[]> {
    const users = new Map(
      (await this.accounts.getUsersByIds(customers.map((c) => c.userId))).map((u) => [u.id, u]),
    );
    return customers.map((customer) => {
      const user = users.get(customer.userId);
      // customers.user_id is a FK to users: a miss is a broken invariant, not a client error.
      if (!user) throw new Error(`customer ${customer.id} has no user ${customer.userId}`);
      return { customer, user };
    });
  }
}
