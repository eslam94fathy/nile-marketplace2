import { type Knex } from 'knex';

// customers: the customer profile of a `users` row with role customer (02-database.md §3, G12).
// Created in the same transaction as the user at self-registration (spec 04 UC-CU-1).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE customers (
      id         UUID         NOT NULL DEFAULT uuidv7(),
      user_id    UUID         NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name  VARCHAR(100) NOT NULL,
      phone      VARCHAR(16)  NOT NULL,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_customers PRIMARY KEY (id),
      -- Resolve the profile from the JWT sub: WHERE user_id = ? (one profile per user).
      CONSTRAINT uq_customers_user_id UNIQUE (user_id),
      CONSTRAINT fk_customers_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
      -- E.164; the DTO narrows it to Egyptian mobiles.
      CONSTRAINT chk_customers_phone CHECK (phone ~ '^\\+[1-9][0-9]{6,14}$')
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS customers`);
}
