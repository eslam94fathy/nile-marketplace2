import { type Knex } from 'knex';

// catalog: the option a variant has for each effective attribute (composite PK, SD-8). Kept for
// deleted variants too, so options and attributes in use can't be deleted (spec 06 UC-CA-2).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE variant_attribute_values (
      variant_id   UUID NOT NULL,
      attribute_id UUID NOT NULL,
      option_id    UUID NOT NULL,
      -- One value per attribute per variant. Also serves "attributes of these variants" (batched):
      -- WHERE variant_id = ANY(?)
      CONSTRAINT pk_variant_attribute_values PRIMARY KEY (variant_id, attribute_id),
      CONSTRAINT fk_variant_attribute_values_variant_id
        FOREIGN KEY (variant_id) REFERENCES product_variants (id) ON DELETE CASCADE,
      -- Attribute deletes are rare admin operations, checked by the app first: no index.
      CONSTRAINT fk_variant_attribute_values_attribute_id
        FOREIGN KEY (attribute_id) REFERENCES category_attributes (id) ON DELETE RESTRICT,
      CONSTRAINT fk_variant_attribute_values_option_id
        FOREIGN KEY (option_id) REFERENCES category_attribute_options (id) ON DELETE RESTRICT
    );

    -- Listing filter attr.size=xl: EXISTS (... WHERE option_id = ANY(?) AND variant_id = v.id).
    -- Also serves "is this option used?" and the option FK.
    CREATE INDEX idx_variant_attribute_values_option_id_variant_id
      ON variant_attribute_values (option_id, variant_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS variant_attribute_values`);
}
