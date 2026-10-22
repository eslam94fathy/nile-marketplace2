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
   * A refund due (spec 10 UC-PA-3, UC-PA-5): `auto` = a Kashier refund for the job (`pending_auto`,
   * due at `now`, K-12); otherwise one an admin does by hand and records (UC-PA-4, COD returns).
   */
  async insertPending(
    refund: {
      paymentId: string;
      sellerOrderId: string | null;
      amount: Money;
      reason: RefundReason;
      returnId?: string;
      payoutDetailsEncrypted?: string | null;
      /** Kashier: the refund job does it (UC-PA-6). */
      autoAt?: Date;
    },
    trx: DbTransaction,
  ): Promise<void> {
    await trx<PaymentRefundTable>(T).insert({
      payment_id: refund.paymentId,
      seller_order_id: refund.sellerOrderId,
      amount: refund.amount.toString(),
      reason: refund.reason,
      status: refund.autoAt ? RefundStatus.PENDING_AUTO : RefundStatus.PENDING_MANUAL,
      recorded_by_user_id: null,
      recorded_at: null,
      provider_refund_ref: null,
      return_id: refund.returnId ?? null,
      method: refund.autoAt ? RefundMethod.KASHIER_AUTO : RefundMethod.MANUAL,
      attempt_count: 0,
      next_attempt_at: refund.autoAt ?? null,
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

  /** The job's candidates, due first (UC-PA-6): idx_payment_refunds_next_attempt_at_id, read without locks. */
  async findDueIds(now: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .knex<PaymentRefundTable>(T)
      .select('id')
      .where({ status: RefundStatus.PENDING_AUTO })
      .where('next_attempt_at', '<=', now)
      .orderBy([{ column: 'next_attempt_at' }, { column: 'id' }])
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** Refunds left `processing` since before `before` (§8.3 step 4): idx_payment_refunds_processing. */
  async findStuckIds(before: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .knex<PaymentRefundTable>(T)
      .select('id')
      .where({ status: RefundStatus.PROCESSING })
      .where('updated_at', '<', before)
      .orderBy('updated_at')
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** The refund row `FOR UPDATE`; with `skipLocked` a busy one reads as missing (the job). */
  async lockById(
    id: string,
    trx: DbTransaction,
    options: { skipLocked?: boolean } = {},
  ): Promise<PaymentRefund | null> {
    const qb = trx<PaymentRefundTable>(T).select('id').where({ id }).forUpdate();
    if (options.skipLocked) void qb.skipLocked();
    if (!(await qb.first())) return null;
    return this.findById(id, trx);
  }

  /**
   * K-11: another refund of the payment was sent, done or recorded since `since`; a same-amount refund
   * sent now could be replayed by Kashier instead of run. Over idx_payment_refunds_payment_id.
   */
  async hasRecentAttempt(
    paymentId: string,
    exceptId: string,
    since: Date,
    trx: DbTransaction,
  ): Promise<boolean> {
    const { rows } = await trx.raw<{ rows: { found: boolean }[] }>(
      `SELECT EXISTS (SELECT 1 FROM ${T} WHERE payment_id = ? AND id <> ? AND status IN (?, ?, ?) AND updated_at > ?) AS found`,
      [paymentId, exceptId, RefundStatus.PROCESSING, RefundStatus.SUCCEEDED, RefundStatus.RECORDED, since],
    );
    return rows[0]?.found === true;
  }

  /** K-11: Kashier's refund transaction id is already one of the payment's refunds (a replayed answer). */
  async hasProviderRef(paymentId: string, providerRefundRef: string, trx: DbTransaction): Promise<boolean> {
    const { rows } = await trx.raw<{ rows: { found: boolean }[] }>(
      `SELECT EXISTS (SELECT 1 FROM ${T} WHERE payment_id = ? AND provider_refund_ref = ?) AS found`,
      [paymentId, providerRefundRef],
    );
    return rows[0]?.found === true;
  }

  /** UC-PA-6 step 1: `pending_auto → processing`, one more attempt. */
  async markProcessing(id: string, trx: DbTransaction): Promise<void> {
    await this.move(
      id,
      RefundStatus.PENDING_AUTO,
      { status: RefundStatus.PROCESSING, attempt_count: trx.raw('attempt_count + 1') },
      trx,
    );
  }

  /** K-11 spacing: still `pending_auto`, later. */
  async defer(id: string, nextAttemptAt: Date, trx: DbTransaction): Promise<void> {
    await this.move(id, RefundStatus.PENDING_AUTO, { next_attempt_at: nextAttemptAt }, trx);
  }

  /** UC-PA-6 success: `processing → succeeded` with Kashier's refund transaction id. */
  async markSucceeded(id: string, providerRefundRef: string, at: Date, trx: DbTransaction): Promise<void> {
    await this.move(
      id,
      RefundStatus.PROCESSING,
      {
        status: RefundStatus.SUCCEEDED,
        provider_refund_ref: providerRefundRef,
        succeeded_at: at,
        last_error: null,
      },
      trx,
    );
  }

  /** A transient failure: back to `pending_auto` for a later attempt. */
  async markRetry(id: string, nextAttemptAt: Date, error: string, trx: DbTransaction): Promise<void> {
    await this.move(
      id,
      RefundStatus.PROCESSING,
      { status: RefundStatus.PENDING_AUTO, next_attempt_at: nextAttemptAt, last_error: error.slice(0, 500) },
      trx,
    );
  }

  /** Given up, refused, unknown or replayed: an admin takes over (`pending_manual`, spec 10 §8.4). */
  async markManual(id: string, error: string, trx: DbTransaction): Promise<void> {
    await this.move(
      id,
      RefundStatus.PROCESSING,
      { status: RefundStatus.PENDING_MANUAL, next_attempt_at: null, last_error: error.slice(0, 500) },
      trx,
    );
  }

  /** Conditional on the expected status, under the caller's lock: a refusal is an invariant violation. */
  private async move(
    id: string,
    from: RefundStatus,
    set: Record<string, unknown>,
    trx: DbTransaction,
  ): Promise<void> {
    const updated = await trx<PaymentRefundTable>(T)
      .update({ ...set, updated_at: trx.fn.now() })
      .where({ id, status: from });
    if (updated !== 1) throw new Error(`refund ${id} is not ${from}`);
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
  async markRetriedByAdmin(id: string, now: Date, trx: DbTransaction): Promise<boolean> {
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
