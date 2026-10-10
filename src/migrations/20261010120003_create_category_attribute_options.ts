import { type Knex } from 'knex';

// catalog: the choices of an attribute (e.g. size XL). Variants pick exactly one option per
// effective attribute (SD-7, spec 06 UC-CA-4).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE category_attribute_options (
      id           UUID        NOT NULL DEFAULT uuidv7(),
      attribute_id UUID        NOT NULL,
      value        VARCHAR(60) NOT NULL,
      code         VARCHAR(60) NOT NULL,
      sort_order   INTEGER     NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_category_attribute_options PRIMARY KEY (id),
      CONSTRAINT fk_category_attribute_options_attribute_id
        FOREIGN KEY (attribute_id) REFERENCES category_attributes (id) ON DELETE RESTRICT,
      -- Options of an attribute: WHERE attribute_id = ANY(?) (loaded with the cached tree).
      CONSTRAINT uq_category_attribute_options_attribute_id_code UNIQUE (attribute_id, code)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS category_attribute_options`);
}
