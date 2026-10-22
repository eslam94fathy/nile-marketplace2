import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { Money } from '../../../lib/money';
import { PAYMENTS_TABLES } from '../constants';
import { RefundMethod, type RefundReason, RefundStatus } from '../enums';
import { type PaymentRefund } from '../model/refund.model';

const T = PAYMENTS_TABLES.PAYMENT_REFUNDS;
const P = PAYMENTS_TABLES.PAYMENTS;
/** Refund columns plus the payment's order; one within-module join (G20). */
const COLUMNS = [
  'r.id',
  'r.payment_id',
  'p.order_id',
  'r.seller_order_id',
  'r.amount',
  'r.reason',
  'r.status',
  'r.provider_refund_ref',
  'r.recorded_by_user_id',
  'r.recorded_at',
  'r.created_at',
] as const;

interface PaymentRefundTable {
  id: string;
  payment_id: string;
  seller_order_id: string | null;
  amount: string;
  reason: RefundReason;
  status: RefundStatus;
  recorded_by_user_id: string | null;
  recorded_at: Date | null;
  provider_refund_ref: string | null;
  return_id: string | null;
  method: RefundMethod;
  attempt_count: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  payout_details_encrypted: string | null;
  succeeded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type RefundRow = Pick<
  PaymentRefundTable,
  | 'id'
  | 'payment_id'
  | 'seller_order_id'
  | 'amount'
  | 'reason'
  | 'status'
  | 'provider_refund_ref'
  | 'recorded_by_user_id'
  | 'recorded_at'
  | 'created_at'
> & { order_id: string };

function toModel(row: RefundRow): PaymentRefund {
  return {
    id: row.id,
    paymentId: row.payment_id,
    orderId: row.order_id,
    sellerOrderId: row.seller_order_id,
    amount: Money.of(row.amount),
    reason: row.reason,
    status: row.status,
    providerRefundRef: row.provider_refund_ref,
    recordedByUserId: row.recorded_by_user_id,
    recordedAt: row.recorded_at,
    createdAt: row.created_at,
  };
}

@injectable()
export class PaymentRefundRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  private select(trx?: DbTransaction) {
    return this.exec(trx)(`${T} as r`)
      .join(`${P} as p`, 'p.id', 'r.payment_id')
      .select(...COLUMNS);
  }

  /** A refund due, waiting for an admin to do it in the Kashier dashboard and record it (UC-PA-4). */
  async insertPending(
    refund: { paymentId: string; sellerOrderId: string | null; amount: Money; reason: RefundReason },
    trx: DbTransaction,
  ): Promise<void> {
    await trx<PaymentRefundTable>(T).insert({
      payment_id: refund.paymentId,
      seller_order_id: refund.sellerOrderId,
      amount: refund.amount.toString(),
      reason: refund.reason,
      status: RefundStatus.PENDING_MANUAL,
      recorded_by_user_id: null,
      recorded_at: null,
      provider_refund_ref: null,
      return_id: null,
      method: RefundMethod.MANUAL,
      attempt_count: 0,
      next_attempt_at: null,
      last_error: null,
      payout_details_encrypted: null,
      succeeded_at: null,
    });
  }

  /** Every refund flagged on the payment, pending or recorded (PA-20); the caller holds the payment lock. */
  async sumForPayment(paymentId: string, trx: DbTransaction): Promise<Money> {
    const { rows } = await trx.raw<{ rows: { total: string }[] }>(
      `SELECT COALESCE(SUM(amount), 0)::numeric(12,2)::text AS total FROM ${T} WHERE payment_id = ?`,
      [paymentId],
    );
    return Money.of(rows[0]?.total ?? '0.00');
  }

  async findById(id: string, trx?: DbTransaction): Promise<PaymentRefund | null> {
    const row = (await this.select(trx).where('r.id', id).first()) as RefundRow | undefined;
    return row ? toModel(row) : null;
  }

  /** Refunds of a payment, oldest first: idx_payment_refunds_payment_id. */
  async listByPaymentId(paymentId: string, trx?: DbTransaction): Promise<PaymentRefund[]> {
    const rows = (await this.select(trx)
      .where('r.payment_id', paymentId)
      .orderBy([{ column: 'r.created_at' }, { column: 'r.id' }])) as RefundRow[];
    return rows.map(toModel);
  }

  /**
   * The admin refund queue, keyset page (`limit + 1` rows): pending ones over
   * idx_payment_refunds_created_at_id (D-8).
   */
  async list(query: ParsedListQuery, trx?: DbTransaction): Promise<PaymentRefund[]> {
    const rows = (await applyListQuery(this.select(trx), query, 'r.id')) as RefundRow[];
    return rows.map(toModel);
  }

  /**
   * UC-PA-4: `pending_manual → recorded`, conditional so a second record of the same refund is refused.
   * The caller holds the payment's row lock. Returns false when it was already recorded.
   */
  async markRecorded(
    id: string,
    record: { providerRefundRef: string; recordedByUserId: string; recordedAt: Date },
    trx: DbTransaction,
  ): Promise<boolean> {
    const updated = await trx<PaymentRefundTable>(T)
      .update({
        status: RefundStatus.RECORDED,
        provider_refund_ref: record.providerRefundRef,
        recorded_by_user_id: record.recordedByUserId,
        recorded_at: record.recordedAt,
        updated_at: trx.fn.now(),
      })
      .where({ id, status: RefundStatus.PENDING_MANUAL });
    return updated === 1;
  }
}
