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
  'r.return_id',
  'r.amount',
  'r.reason',
  'r.status',
  'r.method',
  'r.attempt_count',
  'r.next_attempt_at',
  'r.last_error',
  'r.succeeded_at',
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
  | 'return_id'
  | 'amount'
  | 'reason'
  | 'status'
  | 'method'
  | 'attempt_count'
  | 'next_attempt_at'
  | 'last_error'
  | 'succeeded_at'
  | 'provider_refund_ref'
  | 'recorded_by_user_id'
  | 'recorded_at'
  | 'created_at'
> & { order_id: string; has_payout_details: boolean };

/** The ciphertext never enters the model; only whether it is there. */
const HAS_PAYOUT = 'r.payout_details_encrypted IS NOT NULL AS has_payout_details';

function toModel(row: RefundRow): PaymentRefund {
  return {
    id: row.id,
    paymentId: row.payment_id,
    orderId: row.order_id,
    sellerOrderId: row.seller_order_id,
    returnId: row.return_id,
    amount: Money.of(row.amount),
    reason: row.reason,
    status: row.status,
    method: row.method,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    hasPayoutDetails: row.has_payout_details,
    providerRefundRef: row.provider_refund_ref,
    recordedByUserId: row.recorded_by_user_id,
    recordedAt: row.recorded_at,
    succeededAt: row.succeeded_at,
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
    const executor = this.exec(trx);
    return executor(`${T} as r`)
      .join(`${P} as p`, 'p.id', 'r.payment_id')
      .select(...COLUMNS, executor.raw(HAS_PAYOUT));
  }

  /**
   * A refund due, waiting for an admin to do it (Kashier dashboard, or a COD wallet / InstaPay transfer)
   * and record it (UC-PA-4). Kashier refunds go to the job from R2-P6 step 7 (PA-31).
   */
  async insertPending(
    refund: {
      paymentId: string;
      sellerOrderId: string | null;
      amount: Money;
      reason: RefundReason;
      returnId?: string;
      payoutDetailsEncrypted?: string | null;
    },
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
      return_id: refund.returnId ?? null,
      method: RefundMethod.MANUAL,
      attempt_count: 0,
      next_attempt_at: null,
      last_error: null,
      payout_details_encrypted: refund.payoutDetailsEncrypted ?? null,
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

  /** The sealed COD payout details of a refund (spec 10 §8.4); opened only for the refund detail. */
  async findPayoutDetails(id: string): Promise<string | null> {
    const row = await this.db
      .knex<PaymentRefundTable>(T)
      .select('payout_details_encrypted')
      .where({ id })
      .first<{ payout_details_encrypted: string | null } | undefined>();
    return row?.payout_details_encrypted ?? null;
  }

  /** The refunds of returns, oldest first: idx_payment_refunds_return_id (spec 10 §8.5). */
  async findByReturnIds(returnIds: readonly string[]): Promise<PaymentRefund[]> {
    if (returnIds.length === 0) return [];
    const rows = (await this.select()
      .whereIn('r.return_id', [...new Set(returnIds)])
      .orderBy([{ column: 'r.created_at' }, { column: 'r.id' }])) as RefundRow[];
    return rows.map(toModel);
  }

  /**
   * `POST …/retry` (spec 10 §8.4): a `pending_manual` refund to the job, at once, attempts reset.
   * Conditional; false when it was not `pending_manual`.
   */
  async markRetry(id: string, now: Date, trx: DbTransaction): Promise<boolean> {
    const updated = await trx<PaymentRefundTable>(T)
      .update({
        status: RefundStatus.PENDING_AUTO,
        next_attempt_at: now,
        attempt_count: 0,
        last_error: null,
        updated_at: trx.fn.now(),
      })
      .where({ id, status: RefundStatus.PENDING_MANUAL });
    return updated === 1;
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
