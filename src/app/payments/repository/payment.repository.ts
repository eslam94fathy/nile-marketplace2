import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import { PAYMENTS_TABLES } from '../constants';
import { type PaymentMethod, PaymentStatus } from '../enums';
import { type Payment } from '../model/payment.model';

const T = PAYMENTS_TABLES.PAYMENTS;
const COLUMNS = [
  'id',
  'order_id',
  'customer_id',
  'method',
  'status',
  'amount',
  'collected_amount',
  'refunded_amount',
  'provider_order_ref',
  'provider_session_url',
  'provider_session_expires_at',
  'provider_transaction_ref',
  'paid_at',
  'created_at',
  'updated_at',
] as const;

interface PaymentTable {
  id: string;
  order_id: string;
  customer_id: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amount: string;
  collected_amount: string;
  refunded_amount: string;
  provider_order_ref: string | null;
  provider_session_url: string | null;
  provider_session_expires_at: Date | null;
  provider_transaction_ref: string | null;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type PaymentRow = Pick<PaymentTable, (typeof COLUMNS)[number]>;

function toModel(row: PaymentRow): Payment {
  const { provider_order_ref: id, provider_session_url: url, provider_session_expires_at: expiresAt } = row;
  return {
    id: row.id,
    orderId: row.order_id,
    customerId: row.customer_id,
    method: row.method,
    status: row.status,
    amount: Money.of(row.amount),
    collectedAmount: Money.of(row.collected_amount),
    refundedAmount: Money.of(row.refunded_amount),
    // chk_payments_session_columns: all three set, or none.
    session: id && url && expiresAt ? { id, url, expiresAt } : null,
    providerTransactionRef: row.provider_transaction_ref,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Money taken on a payment (spec 10 UC-PA-2). */
export interface PaidUpdate {
  collectedAmount: Money;
  providerTransactionRef: string | null;
  paidAt: Date;
}

@injectable()
export class PaymentRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** Nothing collected or refunded yet, no provider data (spec 10 §2 `createForOrder`). */
  async insert(
    payment: {
      orderId: string;
      customerId: string;
      method: PaymentMethod;
      status: PaymentStatus;
      amount: Money;
    },
    trx: DbTransaction,
  ): Promise<string> {
    const [row] = await trx<PaymentTable>(T)
      .insert({
        order_id: payment.orderId,
        customer_id: payment.customerId,
        method: payment.method,
        status: payment.status,
        amount: payment.amount.toString(),
        collected_amount: Money.zero().toString(),
        refunded_amount: Money.zero().toString(),
        provider_order_ref: null,
        provider_session_url: null,
        provider_session_expires_at: null,
        provider_transaction_ref: null,
        paid_at: null,
      })
      .returning<Pick<PaymentTable, 'id'>[]>('id');
    if (!row) throw new Error('payments insert returned no row');
    return row.id;
  }

  async findById(id: string, trx?: DbTransaction): Promise<Payment | null> {
    const row = await this.exec(trx)<PaymentTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .first<PaymentRow | undefined>();
    return row ? toModel(row) : null;
  }

  /** The order's payment over uq_payments_order_id. */
  async findByOrderId(orderId: string, trx?: DbTransaction): Promise<Payment | null> {
    const row = await this.exec(trx)<PaymentTable>(T)
      .select(...COLUMNS)
      .where({ order_id: orderId })
      .first<PaymentRow | undefined>();
    return row ? toModel(row) : null;
  }

  /** One batched `order_id IN (...)` query over uq_payments_order_id (G20). */
  async findByOrderIds(orderIds: readonly string[], trx?: DbTransaction): Promise<Payment[]> {
    if (orderIds.length === 0) return [];
    const rows = await this.exec(trx)<PaymentTable>(T)
      .select(...COLUMNS)
      .whereIn('order_id', [...new Set(orderIds)]);
    return rows.map(toModel);
  }

  /** Locks the order's payment (`FOR UPDATE`); null when the order has none. */
  async lockByOrderId(orderId: string, trx: DbTransaction): Promise<Payment | null> {
    const row = await trx<PaymentTable>(T)
      .select(...COLUMNS)
      .where({ order_id: orderId })
      .forUpdate()
      .first<PaymentRow | undefined>();
    return row ? toModel(row) : null;
  }

  /** Locks a payment (`FOR UPDATE`): payments is last in the lock order (spec 10 PA-2). */
  async lockById(id: string, trx: DbTransaction): Promise<Payment | null> {
    const row = await trx<PaymentTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .forUpdate()
      .first<PaymentRow | undefined>();
    return row ? toModel(row) : null;
  }

  /** Writes the amounts and status computed under the row lock the caller holds. */
  async updateAmounts(
    id: string,
    values: { status: PaymentStatus; amount: Money; collectedAmount: Money },
    trx: DbTransaction,
  ): Promise<void> {
    await trx<PaymentTable>(T)
      .update({
        status: values.status,
        amount: values.amount.toString(),
        collected_amount: values.collectedAmount.toString(),
        updated_at: trx.fn.now(),
      })
      .where({ id });
  }

  /**
   * Stores the first Kashier session of a payment (spec 10 PA-3): only while it is `initiated` and has
   * none. Returns false when another request stored one first, or the payment moved on.
   */
  async storeSession(id: string, session: { id: string; url: string; expiresAt: Date }): Promise<boolean> {
    const updated = await this.db
      .knex<PaymentTable>(T)
      .update({
        provider_order_ref: session.id,
        provider_session_url: session.url,
        provider_session_expires_at: session.expiresAt,
        updated_at: this.db.knex.fn.now(),
      })
      .where({ id, status: PaymentStatus.INITIATED })
      .whereNull('provider_order_ref');
    return updated === 1;
  }

  /** Conditional status change (`from` → `to`); returns whether it applied. */
  async transition(
    id: string,
    from: readonly PaymentStatus[],
    to: PaymentStatus,
    trx: DbTransaction,
    paid?: PaidUpdate,
  ): Promise<boolean> {
    const updated = await trx<PaymentTable>(T)
      .update({
        status: to,
        ...(paid
          ? {
              collected_amount: paid.collectedAmount.toString(),
              provider_transaction_ref: paid.providerTransactionRef,
              paid_at: paid.paidAt,
            }
          : {}),
        updated_at: trx.fn.now(),
      })
      .where({ id })
      .whereIn('status', [...from]);
    return updated === 1;
  }

  /** A recorded manual refund (spec 10 UC-PA-4), under the row lock the caller holds. */
  async setRefunded(
    id: string,
    refundedAmount: Money,
    status: PaymentStatus,
    trx: DbTransaction,
  ): Promise<void> {
    await trx<PaymentTable>(T)
      .update({ refunded_amount: refundedAmount.toString(), status, updated_at: trx.fn.now() })
      .where({ id });
  }
}
