import { type Knex } from 'knex';

// finance: a delivered seller order's net held in seller_pending until its return window ends (spec 12
// §8.1, R-16, database v2.0 §14.13, D-24). Seller orders delivered before R2 have no row (FI-13).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE seller_order_holds (
      seller_order_id UUID           NOT NULL,
      seller_id       UUID           NOT NULL,
      -- What is still held: the seller net, less what returns took from pending (spec 12 §8.4).
      held_amount     NUMERIC(12,2)  NOT NULL,
      -- deliveredAt + RETURN_WINDOW_DAYS. Cursor-sorted by GET /seller/finance/holds (D-11).
      release_after   TIMESTAMPTZ(3) NOT NULL,
      released_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
      -- One hold per seller order; the release job and the return bookings lock it by id.
      CONSTRAINT pk_seller_order_holds PRIMARY KEY (seller_order_id),
      -- Cross-module FKs (D12). Sellers are never deleted; seller_id is served by the list index.
      CONSTRAINT fk_seller_order_holds_seller_order_id
        FOREIGN KEY (seller_order_id) REFERENCES seller_orders (id) ON DELETE RESTRICT,
      CONSTRAINT fk_seller_order_holds_seller_id FOREIGN KEY (seller_id) REFERENCES sellers (id) ON DELETE RESTRICT,
      CONSTRAINT chk_seller_order_holds_held_amount CHECK (held_amount >= 0)
    );

    -- Release job (spec 12 §8.3): WHERE released_at IS NULL AND release_after <= now()
    -- ORDER BY release_after LIMIT ?.
    CREATE INDEX idx_seller_order_holds_release_after
      ON seller_order_holds (release_after) WHERE released_at IS NULL;

    -- GET /seller/finance/holds, oldest first (spec 12 §8.6): WHERE seller_id = ? AND released_at IS NULL
    -- ORDER BY release_after, seller_order_id (keyset; the PK is the tie-break).
    CREATE INDEX idx_seller_order_holds_seller_id_release_after
      ON seller_order_holds (seller_id, release_after, seller_order_id) WHERE released_at IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS seller_order_holds`);
}
