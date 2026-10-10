import { type NamedMigration } from '../lib/db/migration-source';
import * as m20261008000001 from './20261008000001_enable_pg_trgm';
import * as m20261008000002 from './20261008000002_create_events_outbox';
import * as m20261008000003 from './20261008000003_create_processed_events';
import * as m20261008123200 from './20261008123200_create_users';
import * as m20261008123202 from './20261008123202_create_refresh_tokens';
import * as m20261008123204 from './20261008123204_create_verification_codes';
import * as m20261008134257 from './20261008134257_create_notification_log';
import * as m20261008135708 from './20261008135708_add_users_role_created_at_index';
import * as m20261009192351 from './20261009192351_create_governorates';
import * as m20261009192353 from './20261009192353_create_delivery_settings';
import * as m20261009194352 from './20261009194352_create_customers';
import * as m20261009194354 from './20261009194354_create_customer_addresses';
import * as m20261009202641 from './20261009202641_create_sellers';
import * as m20261009202643 from './20261009202643_create_seller_status_history';
import * as m20261009202644 from './20261009202644_create_seller_commission_history';
import * as m20261009202646 from './20261009202646_create_seller_settings';
import * as m20261010120001 from './20261010120001_create_categories';
import * as m20261010120002 from './20261010120002_create_category_attributes';
import * as m20261010120003 from './20261010120003_create_category_attribute_options';
import * as m20261010120004 from './20261010120004_create_products';
import * as m20261010120005 from './20261010120005_create_product_variants';
import * as m20261010120006 from './20261010120006_create_variant_attribute_values';
import * as m20261010120007 from './20261010120007_create_inventory_items';
import * as m20261010120008 from './20261010120008_create_inventory_movements';
// <migration-imports> (npm run migrate:make appends above this line)

/** Every migration, in timestamp order. Never edit or reorder an applied one (CLAUDE.md §6.1). */
export const MIGRATIONS: readonly NamedMigration[] = [
  { name: '20261008000001_enable_pg_trgm', module: m20261008000001 },
  { name: '20261008000002_create_events_outbox', module: m20261008000002 },
  { name: '20261008000003_create_processed_events', module: m20261008000003 },
  { name: '20261008123200_create_users', module: m20261008123200 },
  { name: '20261008123202_create_refresh_tokens', module: m20261008123202 },
  { name: '20261008123204_create_verification_codes', module: m20261008123204 },
  { name: '20261008134257_create_notification_log', module: m20261008134257 },
  { name: '20261008135708_add_users_role_created_at_index', module: m20261008135708 },
  { name: '20261009192351_create_governorates', module: m20261009192351 },
  { name: '20261009192353_create_delivery_settings', module: m20261009192353 },
  { name: '20261009194352_create_customers', module: m20261009194352 },
  { name: '20261009194354_create_customer_addresses', module: m20261009194354 },
  { name: '20261009202641_create_sellers', module: m20261009202641 },
  { name: '20261009202643_create_seller_status_history', module: m20261009202643 },
  { name: '20261009202644_create_seller_commission_history', module: m20261009202644 },
  { name: '20261009202646_create_seller_settings', module: m20261009202646 },
  { name: '20261010120001_create_categories', module: m20261010120001 },
  { name: '20261010120002_create_category_attributes', module: m20261010120002 },
  { name: '20261010120003_create_category_attribute_options', module: m20261010120003 },
  { name: '20261010120004_create_products', module: m20261010120004 },
  { name: '20261010120005_create_product_variants', module: m20261010120005 },
  { name: '20261010120006_create_variant_attribute_values', module: m20261010120006 },
  { name: '20261010120007_create_inventory_items', module: m20261010120007 },
  { name: '20261010120008_create_inventory_movements', module: m20261010120008 },
  // <migration-list> (npm run migrate:make appends above this line)
];
