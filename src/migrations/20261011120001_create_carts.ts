import { type Knex } from 'knex';

// cart: one cart per customer, created lazily on the first add (spec 08 §1). The row is also the
// lock every cart write and checkout takes first (spec 08 CT-2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE carts (
      id          UUID        NOT NULL DEFAULT uuidv7(),
      customer_id UUID        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_carts PRIMARY KEY (id),
      -- Cross-module FK (D12).
      CONSTRAINT fk_carts_customer_id FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
      -- My cart: WHERE customer_id = ? (one per customer), and the conflict target of the add's
      -- INSERT … ON CONFLICT (customer_id) DO UPDATE create-and-lock.
      CONSTRAINT uq_carts_customer_id UNIQUE (customer_id)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS carts`);
}
