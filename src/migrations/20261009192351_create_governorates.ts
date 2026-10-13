import { type Knex } from 'knex';

// delivery: the 27 governorates of Egypt and their delivery fee (02-database.md §10, spec 11 §1).
// `delivery_fee` NULL = not deliverable (Q-26). Seeded with NULL everywhere: real fees are business
// data that an admin sets (spec 11 DE-2). Names are English; the app localizes by `code` (DE-1).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE governorates (
      id           UUID          NOT NULL DEFAULT uuidv7(),
      code         VARCHAR(10)   NOT NULL,
      name         VARCHAR(100)  NOT NULL,
      delivery_fee NUMERIC(12,2) NULL,
      created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
      CONSTRAINT pk_governorates PRIMARY KEY (id),
      -- ISO 3166-2:EG, e.g. EG-C, EG-ALX
      CONSTRAINT chk_governorates_code CHECK (code ~ '^EG-[A-Z]{1,3}$'),
      CONSTRAINT chk_governorates_delivery_fee CHECK (delivery_fee IS NULL OR delivery_fee >= 0)
    );

    -- Lookup by the stable ISO code (seeds, tests, the app's localized labels).
    -- No other index: the whole table (27 rows) is read at once and cached (architecture §8).
    CREATE UNIQUE INDEX uq_governorates_code ON governorates (code);

    INSERT INTO governorates (code, name, delivery_fee) VALUES
      ('EG-ALX', 'Alexandria', NULL),
      ('EG-ASN', 'Aswan', NULL),
      ('EG-AST', 'Asyut', NULL),
      ('EG-BA', 'Red Sea', NULL),
      ('EG-BH', 'Beheira', NULL),
      ('EG-BNS', 'Beni Suef', NULL),
      ('EG-C', 'Cairo', NULL),
      ('EG-DK', 'Dakahlia', NULL),
      ('EG-DT', 'Damietta', NULL),
      ('EG-FYM', 'Faiyum', NULL),
      ('EG-GH', 'Gharbia', NULL),
      ('EG-GZ', 'Giza', NULL),
      ('EG-IS', 'Ismailia', NULL),
      ('EG-JS', 'South Sinai', NULL),
      ('EG-KB', 'Qalyubia', NULL),
      ('EG-KFS', 'Kafr El Sheikh', NULL),
      ('EG-KN', 'Qena', NULL),
      ('EG-LX', 'Luxor', NULL),
      ('EG-MN', 'Minya', NULL),
      ('EG-MNF', 'Monufia', NULL),
      ('EG-MT', 'Matrouh', NULL),
      ('EG-PTS', 'Port Said', NULL),
      ('EG-SHG', 'Sohag', NULL),
      ('EG-SHR', 'Sharqia', NULL),
      ('EG-SIN', 'North Sinai', NULL),
      ('EG-SUZ', 'Suez', NULL),
      ('EG-WAD', 'New Valley', NULL);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS governorates`);
}
