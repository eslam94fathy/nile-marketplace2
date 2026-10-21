import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type Rating, RATINGS, REVIEW_TABLES } from '../constants';
import { type RatingSubjectType } from '../enums';
import { type RatingStats } from '../model/review.model';

const T = REVIEW_TABLES.RATING_STATS;

interface RatingStatsRow {
  rating_count: number;
  rating_sum: number;
  count_1: number;
  count_2: number;
  count_3: number;
  count_4: number;
  count_5: number;
  /** BIGINT comes back from pg as a string. */
  version: string;
}

const RETURNING = [
  'rating_count',
  'rating_sum',
  'count_1',
  'count_2',
  'count_3',
  'count_4',
  'count_5',
  'version',
];

function toModel(row: RatingStatsRow): RatingStats {
  return {
    ratingCount: row.rating_count,
    ratingSum: row.rating_sum,
    counts: { 1: row.count_1, 2: row.count_2, 3: row.count_3, 4: row.count_4, 5: row.count_5 },
    version: Number(row.version),
  };
}

/** How many reviews of each rating start or stop counting (spec 17 §1.2). */
export type RatingDelta = Readonly<Record<Rating, number>>;

/** All SQL of `review_rating_stats` (spec 17 §1.2). */
@injectable()
export class RatingStatsRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /**
   * One atomic statement in the caller's transaction, never read-then-write; its row lock is the stats
   * lock of spec 17 §1.2 (review → product stats → seller stats).
   * - Only increments (create, unhide): an upsert, creating the row with the delta or moving it.
   * - Any decrement (rating edit, delete, hide): the review counted before, so the row exists; a plain
   *   UPDATE. An upsert can't carry it: Postgres checks the proposed row's CHECKs (counts >= 0) even when
   *   it conflicts and becomes an update.
   */
  async apply(
    subjectType: RatingSubjectType,
    subjectId: string,
    delta: RatingDelta,
    trx: DbTransaction,
  ): Promise<RatingStats> {
    const count = RATINGS.reduce((n, r) => n + delta[r], 0);
    const sum = RATINGS.reduce((n, r) => n + r * delta[r], 0);
    const values = [count, sum, delta[1], delta[2], delta[3], delta[4], delta[5]];
    const increments = RATINGS.every((r) => delta[r] >= 0);
    const result = increments
      ? await trx.raw<{ rows: RatingStatsRow[] }>(
          `INSERT INTO ${T} AS s (subject_type, subject_id, rating_count, rating_sum,
                                  count_1, count_2, count_3, count_4, count_5, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT (subject_type, subject_id) DO UPDATE SET
             rating_count = s.rating_count + EXCLUDED.rating_count,
             rating_sum = s.rating_sum + EXCLUDED.rating_sum,
             count_1 = s.count_1 + EXCLUDED.count_1,
             count_2 = s.count_2 + EXCLUDED.count_2,
             count_3 = s.count_3 + EXCLUDED.count_3,
             count_4 = s.count_4 + EXCLUDED.count_4,
             count_5 = s.count_5 + EXCLUDED.count_5,
             version = s.version + 1,
             updated_at = now()
           RETURNING ${RETURNING.join(', ')}`,
          [subjectType, subjectId, ...values],
        )
      : await trx.raw<{ rows: RatingStatsRow[] }>(
          `UPDATE ${T} SET
             rating_count = rating_count + ?, rating_sum = rating_sum + ?,
             count_1 = count_1 + ?, count_2 = count_2 + ?, count_3 = count_3 + ?,
             count_4 = count_4 + ?, count_5 = count_5 + ?,
             version = version + 1, updated_at = now()
           WHERE subject_type = ? AND subject_id = ?
           RETURNING ${RETURNING.join(', ')}`,
          [...values, subjectType, subjectId],
        );
    const [row] = result.rows;
    // A decrement without a row means a review counted that was never added: a data defect.
    if (!row) throw new Error(`review_rating_stats has no ${subjectType} row ${subjectId} to decrement`);
    return toModel(row);
  }

  /** The summary read (GET …/reviews/summary), on uq_review_rating_stats_subject_type_subject_id. */
  async find(subjectType: RatingSubjectType, subjectId: string): Promise<RatingStats | undefined> {
    const row = await this.db
      .knex<RatingStatsRow & { subject_type: string; subject_id: string }>(T)
      .select(...RETURNING)
      .where({ subject_type: subjectType, subject_id: subjectId })
      .first<RatingStatsRow | undefined>();
    return row ? toModel(row) : undefined;
  }
}
