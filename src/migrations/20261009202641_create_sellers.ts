import { type Knex } from 'knex';

// sellers: the seller profile of a `users` row with role seller, its pickup address, approval status
// and commission rate (02-database.md §4, spec 05). Status changes are conditional updates plus a
// seller_status_history row in the same transaction.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE sellers (
      id                    UUID         NOT NULL DEFAULT uuidv7(),
      user_id               UUID         NOT NULL,
      business_name         VARCHAR(150) NOT NULL,
      contact_phone         VARCHAR(16)  NOT NULL,
      pickup_governorate_id UUID         NOT NULL,
      pickup_city           VARCHAR(100) NOT NULL,
      pickup_area           VARCHAR(100) NOT NULL,
      pickup_street         VARCHAR(200) NOT NULL,
      pickup_building       VARCHAR(50)  NOT NULL,
      pickup_landmark       VARCHAR(200) NULL,
      status                VARCHAR(20)  NOT NULL,
      -- Set by the app from seller_settings.default_commission_rate at registration (no DB default, G13).
      commission_rate       NUMERIC(5,4) NOT NULL,
      rejection_reason      VARCHAR(500) NULL,
      approved_at           TIMESTAMPTZ  NULL,
      created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_sellers PRIMARY KEY (id),
      -- Resolve the seller from the JWT sub: WHERE user_id = ? (one profile per user).
      CONSTRAINT uq_sellers_user_id UNIQUE (user_id),
      CONSTRAINT fk_sellers_user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
      -- Cross-module FK (D12). The admin list filter on it scans ~2k rows, so no index in R1.
      CONSTRAINT fk_sellers_pickup_governorate_id
        FOREIGN KEY (pickup_governorate_id) REFERENCES governorates (id) ON DELETE RESTRICT,
      CONSTRAINT chk_sellers_status
        CHECK (status IN ('pending_approval', 'approved', 'rejected', 'suspended')),
      CONSTRAINT chk_sellers_commission_rate CHECK (commission_rate BETWEEN 0 AND 1),
      CONSTRAINT chk_sellers_contact_phone CHECK (contact_phone ~ '^\\+[1-9][0-9]{6,14}$'),
      CONSTRAINT chk_sellers_rejection_reason CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
    );

    -- Business names are unique case-insensitively [SD-6].
    CREATE UNIQUE INDEX uq_sellers_business_name_lower ON sellers (lower(business_name));

    -- Admin list filtered by status (the approval queue), cursor-paginated:
    -- WHERE status = ANY(?) ORDER BY created_at DESC, id DESC
    CREATE INDEX idx_sellers_status_created_at_id ON sellers (status, created_at DESC, id DESC);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS sellers`);
}
