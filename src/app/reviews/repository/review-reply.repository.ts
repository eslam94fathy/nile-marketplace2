import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { REVIEW_TABLES } from '../constants';
import { type ReviewReply } from '../model/review.model';

const T = REVIEW_TABLES.REVIEW_REPLIES;
const COLUMNS = ['id', 'review_id', 'seller_id', 'body', 'hidden_at', 'hidden_reason', 'created_at'] as const;

interface ReviewReplyTable {
  id: string;
  review_id: string;
  seller_id: string;
  body: string;
  hidden_at: Date | null;
  hidden_reason: string | null;
  hidden_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toModel(row: Pick<ReviewReplyTable, (typeof COLUMNS)[number]>): ReviewReply {
  return {
    id: row.id,
    reviewId: row.review_id,
    sellerId: row.seller_id,
    body: row.body,
    hiddenAt: row.hidden_at,
    hiddenReason: row.hidden_reason,
    createdAt: row.created_at,
  };
}

/** All SQL of `review_replies` (spec 17 UC-RV-3, UC-RV-4). */
@injectable()
export class ReviewReplyRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /** The reply of each review that has one, hidden ones included: one query on uq_review_replies_review_id. */
  async findByReviewIds(
    reviewIds: readonly string[],
    trx?: DbTransaction,
  ): Promise<Map<string, ReviewReply>> {
    if (reviewIds.length === 0) return new Map();
    const rows = await (trx ?? this.db.knex)<ReviewReplyTable>(T)
      .select(...COLUMNS)
      .whereIn('review_id', [...new Set(reviewIds)]);
    return new Map(rows.map((row) => [row.review_id, toModel(row)]));
  }

  /** UC-RV-3. A second reply fails on uq_review_replies_review_id (REVIEW_ALREADY_REPLIED). */
  async insert(
    reply: { reviewId: string; sellerId: string; body: string },
    trx: DbTransaction,
  ): Promise<ReviewReply> {
    const [row] = await trx<ReviewReplyTable>(T)
      .insert({
        review_id: reply.reviewId,
        seller_id: reply.sellerId,
        body: reply.body,
        hidden_at: null,
        hidden_reason: null,
        hidden_by_user_id: null,
      })
      .returning(COLUMNS);
    if (!row) throw new Error('review_replies insert returned no row');
    return toModel(row);
  }

  /** The reply of a review `FOR UPDATE` (UC-RV-4, after the review's lock). */
  async lockByReviewId(reviewId: string, trx: DbTransaction): Promise<ReviewReply | undefined> {
    const row = await trx<ReviewReplyTable>(T)
      .select(...COLUMNS)
      .where({ review_id: reviewId })
      .forUpdate()
      .first();
    return row ? toModel(row) : undefined;
  }

  /** UC-RV-4: hide (reason, admin, time) or unhide (all three cleared). */
  async setHidden(
    id: string,
    hidden: { reason: string; byUserId: string; at: Date } | null,
    trx: DbTransaction,
  ): Promise<void> {
    await trx<ReviewReplyTable>(T)
      .where({ id })
      .update({
        hidden_at: hidden?.at ?? null,
        hidden_reason: hidden?.reason ?? null,
        hidden_by_user_id: hidden?.byUserId ?? null,
        updated_at: trx.fn.now(),
      });
  }
}
