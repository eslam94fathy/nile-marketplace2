import { type Knex } from 'knex';

// audit: append-only log of every admin write and seed-admin run (spec 20 §2.1, R-19, BO-2).
// The action list grows with each phase: a later migration replaces chk_admin_audit_log_action.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE admin_audit_log (
      id             UUID           NOT NULL DEFAULT uuidv7(),
      actor_type     VARCHAR(10)    NOT NULL,
      -- null only for the CLI (chk_admin_audit_log_actor).
      actor_user_id  UUID,
      action         VARCHAR(60)    NOT NULL,
      target_type    VARCHAR(30)    NOT NULL,
      -- Polymorphic (P7-Q3 pattern), so no FK; null for settings.
      target_id      UUID,
      -- { before, after } of the action's allow-listed fields only (spec 20 §2.2).
      changes        JSONB,
      reason         VARCHAR(500),
      correlation_id UUID,
      ip             INET,
      -- Cursor-sorted by the audit list (D-11). No updated_at: rows never change.
      created_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
      CONSTRAINT pk_admin_audit_log PRIMARY KEY (id),
      CONSTRAINT fk_admin_audit_log_actor_user_id
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_admin_audit_log_actor_type CHECK (actor_type IN ('admin', 'cli')),
      CONSTRAINT chk_admin_audit_log_actor
        CHECK ((actor_type = 'cli') = (actor_user_id IS NULL)),
      CONSTRAINT chk_admin_audit_log_target_type CHECK (target_type IN (
        'user', 'seller', 'category', 'attribute', 'option', 'product', 'governorate', 'setting',
        'delivery_agent', 'shipment', 'order', 'seller_order', 'payment_refund', 'cod_remittance',
        'payout', 'support_ticket', 'review', 'review_reply'
      )),
      CONSTRAINT chk_admin_audit_log_action CHECK (action IN (
        'admin.invited', 'admin.seeded', 'user.invite_resent', 'user.suspended', 'user.reactivated',
        'seller.approved', 'seller.rejected', 'seller.suspended', 'seller.reinstated',
        'seller.commission_changed', 'setting.default_commission_changed',
        'category.created', 'category.updated', 'category.image_set', 'category.image_removed',
        'attribute.created', 'attribute.updated', 'attribute.deleted',
        'option.created', 'option.updated', 'option.deleted',
        'governorate.updated', 'setting.delivery_changed',
        'delivery_agent.created', 'delivery_agent.updated', 'delivery_agent.deactivated',
        'delivery_agent.activated', 'shipment.admin_assigned',
        'payment_refund.recorded', 'cod_remittance.recorded', 'payout.recorded'
      )),
      CONSTRAINT chk_admin_audit_log_changes_size CHECK (pg_column_size(changes) <= 8192)
    );

    -- Unfiltered admin list: ORDER BY created_at DESC, id DESC; also the retention job's range.
    CREATE INDEX idx_admin_audit_log_created_at_id ON admin_audit_log (created_at DESC, id DESC);

    -- One target's history: WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC, id DESC.
    CREATE INDEX idx_admin_audit_log_target_type_target_id_created_at_id
      ON admin_audit_log (target_type, target_id, created_at DESC, id DESC);

    -- One admin's actions: WHERE actor_user_id = ? ORDER BY created_at DESC, id DESC.
    CREATE INDEX idx_admin_audit_log_actor_user_id_created_at_id
      ON admin_audit_log (actor_user_id, created_at DESC, id DESC);

    -- Append-only (BO-2): rows are never changed; DELETE stays for the retention job.
    CREATE FUNCTION admin_audit_log_no_update() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'admin_audit_log is append-only';
      END;
      $$;

    CREATE TRIGGER trg_admin_audit_log_no_update
      BEFORE UPDATE ON admin_audit_log
      FOR EACH ROW EXECUTE FUNCTION admin_audit_log_no_update();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS admin_audit_log;
    DROP FUNCTION IF EXISTS admin_audit_log_no_update();
  `);
}
