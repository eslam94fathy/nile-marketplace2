import { type Knex } from 'knex';

// reviews: the rating aggregate of every product and every seller (spec 17 §1.2, database v2.0
// §14.8). Moved only by atomic upserts in the review write's transaction; never read-then-written.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE review_rating_stats (
      id           UUID        NOT NULL DEFAULT uuidv7(),
      subject_type VARCHAR(10) NOT NULL,
      -- A product or a seller id: polymorphic, so no FK (P7-Q3 pattern).
      subject_id   UUID        NOT NULL,
      rating_count INTEGER     NOT NULL,
      rating_sum   INTEGER     NOT NULL,
      count_1      INTEGER     NOT NULL,
      count_2      INTEGER     NOT NULL,
      count_3      INTEGER     NOT NULL,
      count_4      INTEGER     NOT NULL,
      count_5      INTEGER     NOT NULL,
      -- Bumped by every change; the projections apply only a newer one (spec 17 §1.2).
      version      BIGINT      NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_review_rating_stats PRIMARY KEY (id),
      -- The upsert target (INSERT ... ON CONFLICT) and the summary read: WHERE subject_type = ? AND subject_id = ?.
      CONSTRAINT uq_review_rating_stats_subject_type_subject_id UNIQUE (subject_type, subject_id),
      CONSTRAINT chk_review_rating_stats_subject_type CHECK (subject_type IN ('product', 'seller')),
      CONSTRAINT chk_review_rating_stats_counts CHECK (
        count_1 >= 0 AND count_2 >= 0 AND count_3 >= 0 AND count_4 >= 0 AND count_5 >= 0
        AND rating_count = count_1 + count_2 + count_3 + count_4 + count_5
      ),
      CONSTRAINT chk_review_rating_stats_sum
        CHECK (rating_sum BETWEEN rating_count AND 5 * rating_count),
      CONSTRAINT chk_review_rating_stats_version CHECK (version >= 1)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS review_rating_stats;`);
}
