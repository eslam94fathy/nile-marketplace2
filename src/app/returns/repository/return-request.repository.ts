import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { Money, Rate } from '../../../lib/money';
import { RETURN_NUMBER, RETURNS_TABLES } from '../constants';
import {
  type RefundPayoutMethod,
  type ReturnFeePayer,
  type ReturnReason,
  type ReturnRefusalReason,
  ReturnStatus,
} from '../enums';
import { type NewReturnRequest, type ReturnPatch, type ReturnRequest } from '../model/return-request.model';

const T = RETURNS_TABLES.REQUESTS;
const COLUMNS = [
  'id',
  'return_number',
  'seller_order_id',
  'order_id',
  'customer_id',
  'seller_id',
  'status',
  'reason',
  'description',
  'return_fee',
  'return_fee_payer',
  'agent_share_rate',
  'refund_amount',
  'refund_payout_method',
  'agent_id',
  'rejection_reason',
  'refusal_reason',
  'escalation_note',
  'dispute_reason',
  'seller_decision_deadline_at',
  'escalation_deadline_at',
  'inspection_deadline_at',
  'approved_at',
  'received_at',
  'completed_at',
  'created_at',
] as const;

interface ReturnRequestTable {
  id: string;
  return_number: string;
  seller_order_id: string;
  order_id: string;
  customer_id: string;
  seller_id: string;
  status: ReturnStatus;
  reason: ReturnReason;
  description: string | null;
  return_fee: string;
  return_fee_payer: ReturnFeePayer;
  agent_share_rate: string;
  refund_amount: string;
  refund_payout_method: RefundPayoutMethod | null;
  refund_payout_encrypted: string | null;
  agent_id: string | null;
  rejection_reason: string | null;
  refusal_reason: ReturnRefusalReason | null;
  escalation_note: string | null;
  dispute_reason: string | null;
  seller_decision_deadline_at: Date | null;
  escalation_deadline_at: Date | null;
  inspection_deadline_at: Date | null;
  approved_at: Date | null;
  received_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type ReturnRequestRow = Pick<ReturnRequestTable, (typeof COLUMNS)[number]> & { has_refund_payout: boolean };

/** The ciphertext itself is never selected into the model; only whether it is there. */
const HAS_PAYOUT = 'refund_payout_encrypted IS NOT NULL AS has_refund_payout';

function toModel(row: ReturnRequestRow): ReturnRequest {
  return {
    id: row.id,
    returnNumber: row.return_number,
    sellerOrderId: row.seller_order_id,
    orderId: row.order_id,
    customerId: row.customer_id,
    sellerId: row.seller_id,
    status: row.status,
    reason: row.reason,
    description: row.description,
    returnFee: Money.of(row.return_fee),
    returnFeePayer: row.return_fee_payer,
    agentShareRate: Rate.of(row.agent_share_rate),
    refundAmount: Money.of(row.refund_amount),
    refundPayoutMethod: row.refund_payout_method,
    hasRefundPayout: row.has_refund_payout,
    agentId: row.agent_id,
    rejectionReason: row.rejection_reason,
    refusalReason: row.refusal_reason,
    escalationNote: row.escalation_note,
    disputeReason: row.dispute_reason,
    sellerDecisionDeadlineAt: row.seller_decision_deadline_at,
    escalationDeadlineAt: row.escalation_deadline_at,
    inspectionDeadlineAt: row.inspection_deadline_at,
    approvedAt: row.approved_at,
    receivedAt: row.received_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

/** The deadline each job watches (spec 18 UC-RE-9). */
const DEADLINE_COLUMN = {
  [ReturnStatus.REQUESTED]: 'seller_decision_deadline_at',
  [ReturnStatus.REJECTED]: 'escalation_deadline_at',
  [ReturnStatus.RECEIVED]: 'inspection_deadline_at',
} as const;

/** Restricts a read or lock to the caller's own requests: another party's request reads as missing. */
export interface ReturnOwner {
  customerId?: string;
  sellerId?: string;
}

const ownerWhere = (owner: ReturnOwner) => ({
  ...(owner.customerId !== undefined ? { customer_id: owner.customerId } : {}),
  ...(owner.sellerId !== undefined ? { seller_id: owner.sellerId } : {}),
});

/** All SQL of `return_requests` (spec 18). */
@injectable()
export class ReturnRequestRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  private select(executor: DbExecutor) {
    return executor<ReturnRequestTable>(T).select(...COLUMNS, executor.raw(HAS_PAYOUT));
  }

  /**
   * UC-RE-1: a new `requested` row, numbered from the sequence in the INSERT (RE-21). A second open
   * request of the seller order fails on uq_return_requests_seller_order_id_open (→ RETURN_ALREADY_OPEN).
   */
  async insert(request: NewReturnRequest, trx: DbTransaction): Promise<ReturnRequest> {
    const [row] = await trx<ReturnRequestTable>(T)
      .insert({
        return_number: trx.raw(`? || lpad(nextval(?)::text, ?, '0')`, [
          RETURN_NUMBER.PREFIX,
          RETURN_NUMBER.SEQUENCE,
          RETURN_NUMBER.DIGITS,
        ]),
        seller_order_id: request.sellerOrderId,
        order_id: request.orderId,
        customer_id: request.customerId,
        seller_id: request.sellerId,
        status: ReturnStatus.REQUESTED,
        reason: request.reason,
        description: request.description,
        return_fee: request.returnFee.toString(),
        return_fee_payer: request.returnFeePayer,
        agent_share_rate: request.agentShareRate.toString(),
        refund_amount: request.refundAmount.toString(),
        refund_payout_method: request.refundPayoutMethod,
        refund_payout_encrypted: null,
        agent_id: null,
        rejection_reason: null,
        refusal_reason: null,
        escalation_note: null,
        dispute_reason: null,
        seller_decision_deadline_at: request.sellerDecisionDeadlineAt,
        escalation_deadline_at: null,
        inspection_deadline_at: null,
        approved_at: null,
        received_at: null,
        completed_at: null,
      })
      .returning<ReturnRequestRow[]>([...COLUMNS, trx.raw(HAS_PAYOUT)]);
    if (!row) throw new Error('return request insert returned no row');
    return toModel(row);
  }

  /** The sealed COD payout details, bound to the new row's id (the AAD needs it, spec 02 §3.1). */
  async setRefundPayout(id: string, sealed: string, trx: DbTransaction): Promise<void> {
    await trx<ReturnRequestTable>(T)
      .update({ refund_payout_encrypted: sealed, updated_at: trx.fn.now() })
      .where({ id });
  }

  async findById(id: string, owner: ReturnOwner = {}, trx?: DbTransaction): Promise<ReturnRequest | null> {
    const row = (await this.select(this.exec(trx))
      .where({ id, ...ownerWhere(owner) })
      .first()) as ReturnRequestRow | undefined;
    return row ? toModel(row) : null;
  }

  /**
   * The request `FOR UPDATE`: every transition starts here (lock order: return → order, spec 18 UC-RE-7).
   * With `skipLocked` (the jobs), a request another transaction holds reads as missing.
   */
  async lockById(
    id: string,
    trx: DbTransaction,
    owner: ReturnOwner = {},
    options: { skipLocked?: boolean } = {},
  ): Promise<ReturnRequest | null> {
    const qb = this.select(trx)
      .where({ id, ...ownerWhere(owner) })
      .forUpdate();
    if (options.skipLocked) void qb.skipLocked();
    const row = (await qb.first()) as ReturnRequestRow | undefined;
    return row ? toModel(row) : null;
  }

  /**
   * Conditional transition on the expected status (spec 18 §1.1), under the caller's lock. Returns the
   * row after the change, or null when it had moved on.
   */
  async transition(
    id: string,
    from: readonly ReturnStatus[],
    patch: ReturnPatch,
    trx: DbTransaction,
  ): Promise<ReturnRequest | null> {
    const [row] = await trx<ReturnRequestTable>(T)
      .update({
        status: patch.status,
        ...(patch.rejectionReason !== undefined ? { rejection_reason: patch.rejectionReason } : {}),
        ...(patch.refusalReason !== undefined ? { refusal_reason: patch.refusalReason } : {}),
        ...(patch.escalationNote !== undefined ? { escalation_note: patch.escalationNote } : {}),
        ...(patch.escalationDeadlineAt !== undefined
          ? { escalation_deadline_at: patch.escalationDeadlineAt }
          : {}),
        ...(patch.approvedAt !== undefined ? { approved_at: patch.approvedAt } : {}),
        ...(patch.agentId !== undefined ? { agent_id: patch.agentId } : {}),
        ...(patch.receivedAt !== undefined ? { received_at: patch.receivedAt } : {}),
        ...(patch.inspectionDeadlineAt !== undefined
          ? { inspection_deadline_at: patch.inspectionDeadlineAt }
          : {}),
        ...(patch.disputeReason !== undefined ? { dispute_reason: patch.disputeReason } : {}),
        ...(patch.completedAt !== undefined ? { completed_at: patch.completedAt } : {}),
        ...(patch.refundAmount !== undefined ? { refund_amount: patch.refundAmount.toString() } : {}),
        ...(patch.clearRefundPayout ? { refund_payout_encrypted: null } : {}),
        updated_at: trx.fn.now(),
      })
      .where({ id })
      .whereIn('status', [...from])
      .returning<ReturnRequestRow[]>([...COLUMNS, trx.raw(HAS_PAYOUT)]);
    return row ? toModel(row) : null;
  }

  /** The sealed payout details for `return.completed` (COD only, RE-8); read under the caller's lock. */
  async findRefundPayout(id: string, trx: DbTransaction): Promise<string | null> {
    const row = await trx<ReturnRequestTable>(T)
      .select('refund_payout_encrypted')
      .where({ id })
      .first<{ refund_payout_encrypted: string | null } | undefined>();
    return row?.refund_payout_encrypted ?? null;
  }

  /**
   * The jobs' candidates (UC-RE-9), oldest deadline first, read without locks: one of
   * idx_return_requests_seller_decision / _escalation / _inspection.
   */
  async findIdsPastDeadline(
    status: typeof ReturnStatus.REQUESTED | typeof ReturnStatus.REJECTED | typeof ReturnStatus.RECEIVED,
    now: Date,
    limit: number,
  ): Promise<string[]> {
    const column = DEADLINE_COLUMN[status];
    const rows = await this.db
      .knex<ReturnRequestTable>(T)
      .select('id')
      .where({ status })
      .where(column, '<=', now)
      .orderBy(column)
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /**
   * A keyset page (`limit + 1` rows). Customer and seller lists run on
   * idx_return_requests_customer_id_created_at_id / _seller_id_; the admin list without a party filter
   * on idx_return_requests_created_at_id.
   */
  async list(owner: ReturnOwner, query: ParsedListQuery): Promise<ReturnRequest[]> {
    const qb = this.select(this.db.knex).where(ownerWhere(owner));
    const rows = (await applyListQuery(qb, query, 'id')) as ReturnRequestRow[];
    return rows.map(toModel);
  }
}
