import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ListMigrationSource, type MigrationModule } from '../../lib/db';
import { MIGRATIONS } from '..';

const noop: MigrationModule = { up: () => Promise.resolve(), down: () => Promise.resolve() };

describe('migrations list (ListMigrationSource)', () => {
  it('serves the registered migrations in order', async () => {
    const source = new ListMigrationSource(MIGRATIONS);
    const listed = await source.getMigrations();
    expect(listed.map((m) => source.getMigrationName(m))).toEqual([
      '20261008000001_enable_pg_trgm',
      '20261008000002_create_events_outbox',
      '20261008000003_create_processed_events',
      '20261008123200_create_users',
      '20261008123202_create_refresh_tokens',
      '20261008123204_create_verification_codes',
      '20261008134257_create_notification_log',
      '20261008135708_add_users_role_created_at_index',
      '20261009192351_create_governorates',
      '20261009192353_create_delivery_settings',
      '20261009194352_create_customers',
      '20261009194354_create_customer_addresses',
      '20261009202641_create_sellers',
      '20261009202643_create_seller_status_history',
      '20261009202644_create_seller_commission_history',
      '20261009202646_create_seller_settings',
      '20261010120001_create_categories',
      '20261010120002_create_category_attributes',
      '20261010120003_create_category_attribute_options',
      '20261010120004_create_products',
      '20261010120005_create_product_variants',
      '20261010120006_create_variant_attribute_values',
      '20261010120007_create_inventory_items',
      '20261010120008_create_inventory_movements',
      '20261011120001_create_carts',
      '20261011120002_create_cart_items',
      '20261012120001_create_orders',
      '20261012120002_create_seller_orders',
      '20261012120003_create_order_items',
      '20261012120004_create_order_item_cancellations',
      '20261012120005_create_order_status_history',
      '20261012120006_create_seller_order_status_history',
      '20261012120007_create_inventory_reservations',
      '20261012120008_create_payments',
      '20261012120009_create_payment_refunds',
      '20261012120010_create_payment_events',
      '20261012130001_create_delivery_agents',
      '20261012130002_create_shipments',
      '20261012130003_create_shipment_attempts',
      '20261012130004_create_shipment_status_history',
      '20261012140001_cursor_timestamps_millisecond_precision',
      '20261013120001_create_finance_accounts',
      '20261013120002_create_ledger_entries',
      '20261013120003_create_cod_remittances',
      '20261013120004_create_payouts',
      '20261013150001_add_products_min_price_id_index',
      '20261020120001_create_admin_audit_log',
      '20261020130001_create_media_objects',
      '20261020140001_add_categories_image',
      '20261020140002_create_product_images',
      '20261020170202_add_order_items_image_media_id',
      '20261020170204_validate_order_items_image_media_id_fk',
      '20261020170206_add_order_items_image_media_id_index',
      '20261020194936_create_user_notifications',
      '20261020194938_create_notification_preferences',
      '20261020203245_create_push_subscriptions',
      '20261021100001_create_support_tickets',
      '20261021100002_create_support_messages',
      '20261021100003_create_support_message_attachments',
      '20261021100004_create_support_ticket_reads',
      '20261021100005_add_support_audit_actions',
      '20261021120001_add_products_rating',
      '20261021120002_validate_products_rating_checks',
      '20261021120003_add_products_rating_index',
      '20261021120004_add_sellers_rating',
      '20261021120005_create_product_reviews',
      '20261021120006_create_review_images',
      '20261021120007_create_review_replies',
      '20261021120008_create_review_rating_stats',
      '20261021120009_create_wishlist_items',
      '20261021120010_add_review_audit_actions',
      '20261021140001_add_products_admin_block',
      '20261021140002_validate_products_admin_block',
      '20261021140003_add_seller_orders_admin_cancelled',
      '20261021140004_validate_seller_orders_cancel_reason',
      '20261021140005_add_orders_placed_at_index',
      '20261021140006_add_seller_orders_delivered_at_index',
      '20261021140007_add_users_email_pattern_index',
      '20261021140008_add_customers_name_trgm_index',
      '20261021140009_add_customers_phone_index',
      '20261021140010_add_backoffice_audit_actions',
      '20261021150001_customers_created_at_millisecond_precision',
      '20261021150002_add_users_created_at_id_index',
      '20261021150003_add_customers_created_at_id_index',
      '20261021150004_add_seller_orders_open_status_index',
      '20261022100001_create_return_requests',
      '20261022100002_create_return_items',
      '20261022100003_create_return_photos',
      '20261022100004_create_return_status_history',
      '20261022100005_add_order_items_returned_quantity',
      '20261022100006_validate_order_items_quantities',
      '20261022100007_add_seller_orders_returned_amounts',
      '20261022100008_validate_seller_orders_returned_amounts',
      '20261022100009_create_order_item_returns',
      '20261022100010_add_inventory_movements_return_restock',
      '20261022100011_validate_inventory_movements_type',
      '20261022100012_convert_payments_refunded_statuses',
      '20261022100013_validate_payments_status',
      '20261022100014_add_payment_refunds_automation',
      '20261022100015_validate_payment_refunds_automation',
      '20261022100016_add_payment_refunds_next_attempt_index',
      '20261022100017_add_payment_refunds_processing_index',
      '20261022100018_add_payment_refunds_return_id_index',
      '20261022100019_add_payment_refunds_status_created_at_index',
      '20261022100020_add_shipments_return_kind',
      '20261022100021_validate_shipments_return_kind',
      '20261022100022_add_shipment_status_history_pickup_failed',
      '20261022100023_validate_shipment_status_history_statuses',
      '20261022100024_add_shipments_return_id_unique_index',
      '20261022100025_add_shipments_seller_order_id_delivery_index',
      '20261022100026_drop_shipments_seller_order_id_unique',
      '20261022100027_add_finance_return_accounts',
      '20261022100028_add_ledger_entries_return_types',
      '20261022100029_validate_ledger_entries_types',
      '20261022100030_create_seller_order_holds',
      '20261022100031_add_return_audit_actions',
      '20261022120001_add_payments_customer_id',
      '20261022140001_create_coupons',
      '20261022140002_create_coupon_redemptions',
      '20261022140003_add_orders_coupon',
      '20261022140004_validate_orders_coupon',
      '20261022140005_add_seller_orders_discount',
      '20261022140006_validate_seller_orders_discount',
      '20261022140007_add_order_items_discount',
      '20261022140008_validate_order_items_discount',
      '20261022140009_add_finance_promotions_account',
      '20261022140010_add_ledger_entries_promotion_types',
      '20261022140011_validate_ledger_entries_promotion_types',
      '20261022140012_add_coupon_blocked_notification_type',
      '20261022140013_add_coupon_audit_actions',
      '20261022140014_replace_seller_orders_net_check',
      '20261022140015_validate_seller_orders_net_check',
    ]);
  });

  it('every migration file in the folder is registered (no forgotten migration)', () => {
    const files = readdirSync(join(__dirname, '..'))
      .filter((file) => /^\d{14}_[a-z0-9_]+\.ts$/.test(file))
      .map((file) => file.replace(/\.ts$/, ''));
    expect(MIGRATIONS.map((m) => m.name)).toEqual(files.sort());
  });

  it('every migration has an up and a down', () => {
    for (const { name, module } of MIGRATIONS) {
      expect(typeof module.up, name).toBe('function');
      expect(typeof module.down, name).toBe('function');
    }
  });

  it('rejects out-of-order or duplicate names', () => {
    expect(
      () =>
        new ListMigrationSource([
          { name: '20261008000002_b', module: noop },
          { name: '20261008000001_a', module: noop },
        ]),
    ).toThrow(/timestamp order/);
    expect(
      () =>
        new ListMigrationSource([
          { name: '20261008000001_a', module: noop },
          { name: '20261008000001_a', module: noop },
        ]),
    ).toThrow(/Duplicate/);
  });
});
