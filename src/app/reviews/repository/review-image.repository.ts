import { inject, injectable } from 'tsyringe';
import { type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { REVIEW_TABLES } from '../constants';

const T = REVIEW_TABLES.REVIEW_IMAGES;

interface ReviewImageRow {
  review_id: string;
  media_id: string;
  position: number;
}

/** All SQL of `review_images` (spec 17 §1, RV-3). The media rows are claimed and released by the caller. */
@injectable()
export class ReviewImageRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  /** The review's images, replaced as a whole: positions follow the given order (UC-RV-1, UC-RV-2). */
  async replace(reviewId: string, mediaIds: readonly string[], trx: DbTransaction): Promise<void> {
    await trx<ReviewImageRow>(T).where({ review_id: reviewId }).delete();
    if (mediaIds.length === 0) return;
    await trx<ReviewImageRow>(T).insert(
      mediaIds.map((mediaId, position) => ({ review_id: reviewId, media_id: mediaId, position })),
    );
  }

  /** Media ids per review, in position order: one query on the primary key for a page (G20). */
  async findMediaIds(reviewIds: readonly string[], trx?: DbTransaction): Promise<Map<string, string[]>> {
    if (reviewIds.length === 0) return new Map();
    const rows = await (trx ?? this.db.knex)<ReviewImageRow>(T)
      .select('review_id', 'media_id')
      .whereIn('review_id', [...new Set(reviewIds)])
      .orderBy([{ column: 'review_id' }, { column: 'position' }]);
    const byReview = new Map<string, string[]>();
    for (const row of rows) {
      byReview.set(row.review_id, [...(byReview.get(row.review_id) ?? []), row.media_id]);
    }
    return byReview;
  }
}
