import { type Knex } from 'knex';

// notifications: per-category push preferences (spec 13 §8.1, database v2.0 §14.6). A row exists only
// once the user changes a category; without one the code default applies (no DB default, G13).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE notification_preferences (
      user_id      UUID        NOT NULL,
      category     VARCHAR(20) NOT NULL,
      push_enabled BOOLEAN     NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- (user_id, category) is the natural key (SD-8); also serves "the preferences of these users".
      CONSTRAINT pk_notification_preferences PRIMARY KEY (user_id, category),
      CONSTRAINT fk_notification_preferences_user_id
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_notification_preferences_category
        CHECK (category IN ('orders', 'shipments', 'support', 'promotions'))
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS notification_preferences`);
}
