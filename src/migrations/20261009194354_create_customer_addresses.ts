import { type Knex } from 'knex';

// customers: delivery addresses, soft-deleted (02-database.md §3, spec 04 UC-CU-2).
// Orders keep their own snapshot, so edits and deletes never touch past orders.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE customer_addresses (
      id              UUID         NOT NULL DEFAULT uuidv7(),
      customer_id     UUID         NOT NULL,
      governorate_id  UUID         NOT NULL,
      label           VARCHAR(50)  NOT NULL,
      recipient_name  VARCHAR(100) NOT NULL,
      recipient_phone VARCHAR(16)  NOT NULL,
      city            VARCHAR(100) NOT NULL,
      area            VARCHAR(100) NOT NULL,
      street          VARCHAR(200) NOT NULL,
      building        VARCHAR(50)  NOT NULL,
      floor           VARCHAR(10)  NULL,
      apartment       VARCHAR(10)  NULL,
      landmark        VARCHAR(200) NULL,
      is_default      BOOLEAN      NOT NULL,
      deleted_at      TIMESTAMPTZ  NULL,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_customer_addresses PRIMARY KEY (id),
      CONSTRAINT fk_customer_addresses_customer_id
        FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
      -- Cross-module FK (D12). Never a lookup path (addresses are read by customer), so no index.
      CONSTRAINT fk_customer_addresses_governorate_id
        FOREIGN KEY (governorate_id) REFERENCES governorates (id) ON DELETE RESTRICT,
      CONSTRAINT chk_customer_addresses_recipient_phone CHECK (recipient_phone ~ '^\\+[1-9][0-9]{6,14}$')
    );

    -- My addresses (≤ CUSTOMER_MAX_ADDRESSES rows, so the ORDER BY is cheap) and the live-count / default checks:
    -- WHERE customer_id = ? AND deleted_at IS NULL
    CREATE INDEX idx_customer_addresses_customer_id
      ON customer_addresses (customer_id)
      WHERE deleted_at IS NULL;

    -- At most one live default address per customer.
    CREATE UNIQUE INDEX uq_customer_addresses_customer_id_default
      ON customer_addresses (customer_id)
      WHERE is_default AND deleted_at IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS customer_addresses`);
}
