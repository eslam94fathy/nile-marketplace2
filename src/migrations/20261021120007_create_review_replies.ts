import { type Knex } from 'knex';

// reviews: the seller's one, final reply to a review (spec 17 UC-RV-3, RV-5, database v2.0 §14.8). An
// admin may hide it; the seller can't edit or delete it.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE review_replies (
      id                UUID          NOT NULL DEFAULT uuidv7(),
      review_id         UUID          NOT NULL,
      seller_id         UUID          NOT NULL,
      body              VARCHAR(1000) NOT NULL,
      -- Set together while an admin hides the reply (chk_review_replies_hidden).
      hidden_at         TIMESTAMPTZ,
      hidden_reason     VARCHAR(500),
      hidden_by_user_id UUID,
      created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_review_replies PRIMARY KEY (id),
      -- One reply per review: a second one fails here (23505, REVIEW_ALREADY_REPLIED). Also the
      -- replies of a page of reviews: WHERE review_id = ANY(?).
      CONSTRAINT uq_review_replies_review_id UNIQUE (review_id),
      CONSTRAINT fk_review_replies_review_id
        FOREIGN KEY (review_id) REFERENCES product_reviews (id) ON DELETE RESTRICT,
      CONSTRAINT fk_review_replies_seller_id
        FOREIGN KEY (seller_id) REFERENCES sellers (id) ON DELETE RESTRICT,
      CONSTRAINT fk_review_replies_hidden_by_user_id
        FOREIGN KEY (hidden_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_review_replies_body CHECK (char_length(body) >= 1),
      CONSTRAINT chk_review_replies_hidden CHECK (
        (hidden_at IS NULL) = (hidden_reason IS NULL) AND (hidden_at IS NULL) = (hidden_by_user_id IS NULL)
      ),
      CONSTRAINT chk_review_replies_hidden_reason
        CHECK (hidden_reason IS NULL OR char_length(hidden_reason) >= 3)
    );
    -- Unindexed FKs, by design: seller_id, hidden_by_user_id (replies are read through their review).
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS review_replies;`);
}
