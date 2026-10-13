import { inject, injectable } from 'tsyringe';
import { UserRole } from '../../../lib/auth';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { forbidden } from '../../../lib/error';
import { type ILogger } from '../../../lib/logger';
import { type IAccountService } from '../../identity';
import { type Customer } from '../model/customer.model';
import { type CustomerPatch, type CustomerRepository } from '../repository/customer.repository';

export interface CustomerRegistration {
  /** Already normalised by the DTO (trimmed, lower-cased). */
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
}

export interface CustomerProfile {
  customer: Customer;
  email: string;
}

/** Registration (UC-CU-1) and profile (spec 04 §4.2). */
@injectable()
export class CustomerService {
  constructor(
    @inject(TOKENS.CustomerRepository) private readonly customers: CustomerRepository,
    @inject(TOKENS.AccountService) private readonly accounts: IAccountService,
    @inject(TOKENS.TransactionRunner) private readonly transactions: ITransactionRunner,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  /** EMAIL_ALREADY_REGISTERED comes from identity (the `uq_users_email` mapping). */
  async register(input: CustomerRegistration): Promise<{ userId: string; email: string }> {
    // bcrypt before the transaction, so a slow hash never holds a connection or a lock (C-1).
    const passwordHash = await this.accounts.hashPassword(input.password);
    const customer = await this.transactions.run(async (trx) => {
      const { userId } = await this.accounts.createPendingUser(
        { email: input.email, passwordHash, role: UserRole.CUSTOMER },
        trx,
      );
      return this.customers.insert(
        { userId, firstName: input.firstName, lastName: input.lastName, phone: input.phone },
        trx,
      );
    });
    this.logger.info('customer registered', {
      event: 'CUSTOMER_REGISTERED',
      userId: customer.userId,
      customerId: customer.id,
    });
    return { userId: customer.userId, email: input.email };
  }

  /** The profile behind the token. None (shouldn't happen for a customer token) → FORBIDDEN (spec 01 §6). */
  async requireByUserId(userId: string): Promise<Customer> {
    const customer = await this.customers.findByUserId(userId);
    if (!customer) throw forbidden();
    return customer;
  }

  async getProfile(userId: string): Promise<CustomerProfile> {
    const customer = await this.requireByUserId(userId);
    return { customer, email: await this.emailOf(userId) };
  }

  async updateProfile(userId: string, patch: CustomerPatch): Promise<CustomerProfile> {
    const { id } = await this.requireByUserId(userId);
    const customer = await this.customers.update(id, patch);
    if (!customer) throw forbidden();
    return { customer, email: await this.emailOf(userId) };
  }

  private async emailOf(userId: string): Promise<string> {
    const [user] = await this.accounts.getUsersByIds([userId]);
    // customers.user_id is a FK to users, so the user always exists.
    if (!user) throw new Error(`user ${userId} of a customer profile is missing`);
    return user.email;
  }
}
