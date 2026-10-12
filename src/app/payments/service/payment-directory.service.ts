import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type Money } from '../../../lib/money';
import { PaymentMethod, PaymentStatus } from '../enums';
import { type PaymentSummary, toSummary } from '../model/payment.model';
import { type PaymentRepository } from '../repository/payment.repository';

/**
 * Public API of payments (spec 10 §2), injected into ordering. The Kashier methods
 * (createKashierSession, fetchProviderStatus, abandonKashierSession, markPaidFromProvider, expire)
 * land with the Kashier gateway (plan §7.5 PR b).
 */
export interface IPaymentDirectory {
  /** Checkout, in its transaction: COD → `pending`, Kashier → `initiated`. Returns the payment id. */
  createForOrder(
    payment: { orderId: string; method: PaymentMethod; amount: Money },
    trx: DbTransaction,
  ): Promise<string>;
  /** Order views: one batched query; orders without a payment are left out. */
  getSummaries(orderIds: readonly string[], trx?: DbTransaction): Promise<PaymentSummary[]>;
}

@injectable()
export class PaymentDirectory implements IPaymentDirectory {
  constructor(@inject(TOKENS.PaymentRepository) private readonly payments: PaymentRepository) {}

  createForOrder(
    payment: { orderId: string; method: PaymentMethod; amount: Money },
    trx: DbTransaction,
  ): Promise<string> {
    const status = payment.method === PaymentMethod.COD ? PaymentStatus.PENDING : PaymentStatus.INITIATED;
    return this.payments.insert({ ...payment, status }, trx);
  }

  async getSummaries(orderIds: readonly string[], trx?: DbTransaction): Promise<PaymentSummary[]> {
    return (await this.payments.findByOrderIds(orderIds, trx)).map(toSummary);
  }
}
