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
}
