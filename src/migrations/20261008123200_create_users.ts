import { type Knex } from 'knex';

// identity: authentication identity only (G12, docs/design/02-database.md §2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE users (
      id                UUID          NOT NULL DEFAULT uuidv7(),
      email             VARCHAR(254)  NOT NULL,
      password_hash     VARCHAR(60)   NULL,
      role              VARCHAR(20)   NOT NULL,
      status            VARCHAR(30)   NOT NULL,
      email_verified_at TIMESTAMPTZ   NULL,
      last_login_at     TIMESTAMPTZ   NULL,
      created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_users PRIMARY KEY (id),
      -- Login, registration duplicate check, forgot password: lookup by email.
      CONSTRAINT uq_users_email UNIQUE (email),
      CONSTRAINT chk_users_email_lowercase CHECK (email = lower(email)),
      CONSTRAINT chk_users_role CHECK (role IN ('customer', 'seller', 'admin', 'delivery_agent')),
      CONSTRAINT chk_users_status CHECK (status IN ('pending_email_verification', 'invited', 'active', 'suspended')),
      -- Only invited accounts (no password chosen yet) may lack a hash.
      CONSTRAINT chk_users_password_hash_required CHECK (status = 'invited' OR password_hash IS NOT NULL)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS users`);
}
