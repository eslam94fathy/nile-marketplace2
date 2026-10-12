import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import { PAYMENTS_TABLES } from '../constants';
import { type PaymentMethod, type PaymentStatus } from '../enums';
import { type Payment } from '../model/payment.model';

const T = PAYMENTS_TABLES.PAYMENTS;
const COLUMNS = [
  'id',
  'order_id',
  'method',
  'status',
  'amount',
  'collected_amount',
  'refunded_amount',
] as const;

interface PaymentTable {
  id: string;
  order_id: string;
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
  return {
    id: row.id,
    orderId: row.order_id,
    method: row.method,
    status: row.status,
    amount: Money.of(row.amount),
    collectedAmount: Money.of(row.collected_amount),
    refundedAmount: Money.of(row.refunded_amount),
  };
}

@injectable()
export class PaymentRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** Nothing collected or refunded yet, no provider data (spec 10 §2 `createForOrder`). */
  async insert(
    payment: { orderId: string; method: PaymentMethod; status: PaymentStatus; amount: Money },
    trx: DbTransaction,
  ): Promise<string> {
    const [row] = await trx<PaymentTable>(T)
      .insert({
        order_id: payment.orderId,
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
}
