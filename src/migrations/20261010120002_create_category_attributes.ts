import { type Knex } from 'knex';

// catalog: admin-defined attributes of a category, inherited by its descendants (Q-30). `code` is
// the public filter key (`attr.<code>`); the app also rejects a code that exists on an ancestor or
// a descendant (spec 06 UC-CA-2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE category_attributes (
      id          UUID        NOT NULL DEFAULT uuidv7(),
      category_id UUID        NOT NULL,
      name        VARCHAR(60) NOT NULL,
      code        VARCHAR(60) NOT NULL,
      sort_order  INTEGER     NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_category_attributes PRIMARY KEY (id),
      CONSTRAINT fk_category_attributes_category_id
        FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT,
      -- Loaded with the cached tree; also serves the FK (category_id leads).
      CONSTRAINT uq_category_attributes_category_id_code UNIQUE (category_id, code)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS category_attributes`);
}
