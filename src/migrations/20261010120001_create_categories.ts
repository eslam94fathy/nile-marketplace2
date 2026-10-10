import { type Knex } from 'knex';

// catalog: the category tree, max depth 3; products may attach to any level (Q-30, spec 06 UC-CA-1).
// Categories are deactivated, never deleted, because products reference them.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE categories (
      id         UUID         NOT NULL DEFAULT uuidv7(),
      parent_id  UUID         NULL,
      name       VARCHAR(100) NOT NULL,
      slug       VARCHAR(120) NOT NULL,
      -- Set by the app: parent depth + 1, root = 1.
      depth      SMALLINT     NOT NULL,
      sort_order INTEGER      NOT NULL,
      is_active  BOOLEAN      NOT NULL,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
      CONSTRAINT pk_categories PRIMARY KEY (id),
      -- The whole tree (hundreds of rows) is read at once and cached: no index on parent_id.
      CONSTRAINT fk_categories_parent_id FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE RESTRICT,
      -- Lookup by slug.
      CONSTRAINT uq_categories_slug UNIQUE (slug),
      CONSTRAINT chk_categories_depth CHECK (depth BETWEEN 1 AND 3)
    );

    -- No duplicate sibling names, root level included.
    CREATE UNIQUE INDEX uq_categories_parent_id_name_lower
      ON categories (parent_id, lower(name)) NULLS NOT DISTINCT;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS categories`);
}
