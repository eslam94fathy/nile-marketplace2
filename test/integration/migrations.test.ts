import { randomUUID } from 'node:crypto';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDownAll, migrateLatest } from '../../src/lib/db/migrator';
import { MIGRATIONS } from '../../src/migrations';
import { cartFixtures } from '../helpers/cart-fixtures';
import { catalogFixtures, signatureOf } from '../helpers/catalog-fixtures';
import { deliveryFixtures } from '../helpers/delivery-fixtures';
import { orderFixtures } from '../helpers/order-fixtures';
import { createTestResources, type TestResources } from '../helpers/test-resources';

const HASH = (char: string) => char.repeat(64);

/** Runs `fn` and returns the Postgres error code + constraint name it fails with. */
async function pgFailure(fn: () => Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await fn();
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    return { code, constraint };
  }
  throw new Error('expected the statement to fail');
}

describe('migrations on a real Postgres 18', () => {
  let resources: TestResources;
  let db: Knex;

  const user = (overrides: Record<string, unknown> = {}) => ({
    email: `${randomUUID()}@example.com`,
    password_hash: '$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234',
    role: 'customer',
    status: 'active',
    ...overrides,
  });
  const insertUser = async (overrides: Record<string, unknown> = {}) =>
    (await db('users').insert(user(overrides)).returning<{ id: string }[]>('id'))[0]?.id ?? '';

  beforeAll(async () => {
    resources = await createTestResources();
    db = knex({ client: 'pg', connection: resources.env.DATABASE_URL });
  });
  afterAll(async () => {
    await db.destroy();
    await resources.cleanup();
  });

  it('every migration rolls back and re-applies cleanly (CLAUDE.md §6.1: working downs)', async () => {
    const reverted = await migrateDownAll(db, MIGRATIONS);
    expect(reverted).toHaveLength(MIGRATIONS.length);
    const tables = await db.raw<{ rows: unknown[] }>(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE 'knex_%'`,
    );
    expect(tables.rows).toHaveLength(0);
    expect(await migrateLatest(db, MIGRATIONS)).toHaveLength(MIGRATIONS.length);
  });

  describe('users', () => {
    it('idx_users_role_created_at (DB-Q6) is valid and serves the admin list keyset query', async () => {
      const index = await db.raw<{ rows: { valid: boolean; definition: string }[] }>(
        `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS definition
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'idx_users_role_created_at'`,
      );
      expect(index.rows[0]?.valid).toBe(true);
      expect(index.rows[0]?.definition).toContain('(role, created_at DESC, id DESC)');

      // The table is tiny here, so forbid the seq scan to see that the planner can use the index.
      const plan = await db.transaction(async (trx) => {
        await trx.raw('SET LOCAL enable_seqscan = off');
        const result = await trx.raw<{ rows: { 'QUERY PLAN': string }[] }>(
          `EXPLAIN SELECT id FROM users WHERE role = 'admin'
             AND (created_at, id) < (now(), '0192f5e0-0000-7000-8000-000000000000')
             ORDER BY created_at DESC, id DESC LIMIT 21`,
        );
        return result.rows.map((row) => row['QUERY PLAN']).join('\n');
      });
      expect(plan).toContain('idx_users_role_created_at');
      expect(plan).not.toContain('Sort');
    });

    it('stores lower-case emails only, unique', async () => {
      expect(await pgFailure(() => insertUser({ email: 'Mixed@Example.com' }))).toEqual({
        code: '23514',
        constraint: 'chk_users_email_lowercase',
      });
      const email = `${randomUUID()}@example.com`;
      await insertUser({ email });
      expect(await pgFailure(() => insertUser({ email }))).toEqual({
        code: '23505',
        constraint: 'uq_users_email',
      });
    });

    it('only invited accounts may lack a password hash', async () => {
      await expect(insertUser({ status: 'invited', password_hash: null })).resolves.toBeTruthy();
      expect(await pgFailure(() => insertUser({ status: 'active', password_hash: null }))).toEqual({
        code: '23514',
        constraint: 'chk_users_password_hash_required',
      });
    });

    it('whitelists role and status, and has no defaults on business columns (G13)', async () => {
      expect((await pgFailure(() => insertUser({ role: 'moderator' }))).constraint).toBe('chk_users_role');
      expect((await pgFailure(() => insertUser({ status: 'deleted' }))).constraint).toBe('chk_users_status');
      const { role: _role, ...withoutRole } = user();
      expect((await pgFailure(() => db('users').insert(withoutRole))).code).toBe('23502'); // NOT NULL
    });
  });

  describe('refresh_tokens and verification_codes', () => {
    it('require hex SHA-256 hashes; refresh token hashes are unique', async () => {
      const userId = await insertUser();
      const token = (hash: string) => ({
        user_id: userId,
        family_id: randomUUID(),
        token_hash: hash,
        expires_at: new Date(Date.now() + 60_000),
      });
      expect((await pgFailure(() => db('refresh_tokens').insert(token('not-hex')))).code).toBe('23514');
      await db('refresh_tokens').insert(token(HASH('a')));
      expect(await pgFailure(() => db('refresh_tokens').insert(token(HASH('a'))))).toEqual({
        code: '23505',
        constraint: 'uq_refresh_tokens_token_hash',
      });
    });

    it('invite token hashes are unique, OTP hashes need not be', async () => {
      const userId = await insertUser();
      const code = (purpose: string, hash: string) => ({
        user_id: userId,
        purpose,
        code_hash: hash,
        expires_at: new Date(Date.now() + 60_000),
        attempts: 0,
      });
      await db('verification_codes').insert([
        code('email_verification', HASH('b')),
        code('password_reset', HASH('b')),
      ]);
      await db('verification_codes').insert(code('account_invite', HASH('c')));
      expect(
        await pgFailure(() => db('verification_codes').insert(code('account_invite', HASH('c')))),
      ).toEqual({ code: '23505', constraint: 'uq_verification_codes_code_hash' });
      expect(
        (await pgFailure(() => db('verification_codes').insert(code('login', HASH('d'))))).constraint,
      ).toBe('chk_verification_codes_purpose');
    });

    it('deleting a user cascades to its tokens and codes; replaced_by_id is set null on delete', async () => {
      const userId = await insertUser();
      const [first] = await db('refresh_tokens')
        .insert({
          user_id: userId,
          family_id: randomUUID(),
          token_hash: HASH('e'),
          expires_at: new Date(Date.now() + 60_000),
        })
        .returning<{ id: string }[]>('id');
      const [second] = await db('refresh_tokens')
        .insert({
          user_id: userId,
          family_id: randomUUID(),
          token_hash: HASH('f'),
          expires_at: new Date(Date.now() + 60_000),
        })
        .returning<{ id: string }[]>('id');
      await db('refresh_tokens').where({ id: first?.id }).update({ replaced_by_id: second?.id });

      await db('refresh_tokens').where({ id: second?.id }).delete();
      expect(
        (await db('refresh_tokens').where({ id: first?.id }).first<{ replaced_by_id: string | null }>())
          ?.replaced_by_id,
      ).toBeNull();

      await db('verification_codes').insert({
        user_id: userId,
        purpose: 'password_reset',
        code_hash: HASH('9'),
        expires_at: new Date(Date.now() + 60_000),
        attempts: 0,
      });
      await db('users').where({ id: userId }).delete();
      expect(await db('refresh_tokens').where({ user_id: userId })).toHaveLength(0);
      expect(await db('verification_codes').where({ user_id: userId })).toHaveLength(0);
    });
  });

  describe('governorates', () => {
    it('seeds the 27 governorates with ISO codes and no fee (spec 11 DE-2)', async () => {
      const rows = await db('governorates').select<{ code: string; delivery_fee: string | null }[]>(
        'code',
        'delivery_fee',
      );
      expect(rows).toHaveLength(27);
      expect(new Set(rows.map((r) => r.code)).size).toBe(27);
      expect(rows.every((r) => r.delivery_fee === null)).toBe(true);
      expect(rows.map((r) => r.code)).toContain('EG-C');
    });

    it('enforces the code format, unique codes and a non-negative fee', async () => {
      const insert = (code: string, fee: string | null = null) =>
        db('governorates').insert({ code, name: 'Test', delivery_fee: fee });
      expect((await pgFailure(() => insert('CAIRO'))).constraint).toBe('chk_governorates_code');
      expect((await pgFailure(() => insert('EG-C'))).constraint).toBe('uq_governorates_code');
      expect(
        (await pgFailure(() => db('governorates').where({ code: 'EG-C' }).update({ delivery_fee: '-1' })))
          .constraint,
      ).toBe('chk_governorates_delivery_fee');
    });
  });

  describe('delivery_settings', () => {
    it('holds exactly one seeded row (0.7000) and refuses a second one or a rate over 1', async () => {
      const rows =
        await db('delivery_settings').select<{ agent_fee_share_rate: string }[]>('agent_fee_share_rate');
      expect(rows).toEqual([{ agent_fee_share_rate: '0.7000' }]);
      expect(
        (
          await pgFailure(() =>
            db('delivery_settings').insert({ is_singleton: true, agent_fee_share_rate: 0.5 }),
          )
        ).constraint,
      ).toBe('uq_delivery_settings_is_singleton');
      expect(
        (
          await pgFailure(() =>
            db('delivery_settings').insert({ is_singleton: false, agent_fee_share_rate: 0.5 }),
          )
        ).constraint,
      ).toBe('chk_delivery_settings_is_singleton');
      expect(
        (await pgFailure(() => db('delivery_settings').update({ agent_fee_share_rate: 1.5 }))).constraint,
      ).toBe('chk_delivery_settings_agent_fee_share_rate');
    });
  });

  describe('customers + customer_addresses', () => {
    const newCustomer = async () => {
      const userId = await insertUser();
      const [row] = await db('customers')
        .insert({ user_id: userId, first_name: 'Mona', last_name: 'Ali', phone: '+201001234567' })
        .returning<{ id: string }[]>('id');
      return { userId, customerId: row?.id ?? '' };
    };
    const governorateId = async () =>
      (await db('governorates').select('id').where({ code: 'EG-C' }).first<{ id: string }>())?.id ?? '';
    const address = (customerId: string, governorate: string, overrides: Record<string, unknown> = {}) => ({
      customer_id: customerId,
      governorate_id: governorate,
      label: 'Home',
      recipient_name: 'Mona',
      recipient_phone: '+201001234567',
      city: 'Cairo',
      area: 'Zamalek',
      street: 'Street',
      building: '1',
      is_default: false,
      ...overrides,
    });

    it('one profile per user, E.164 phones', async () => {
      const { userId } = await newCustomer();
      const duplicate = () =>
        db('customers').insert({ user_id: userId, first_name: 'A', last_name: 'B', phone: '+201001234567' });
      expect((await pgFailure(duplicate)).constraint).toBe('uq_customers_user_id');
      const badPhone = async () =>
        db('customers').insert({
          user_id: await insertUser(),
          first_name: 'A',
          last_name: 'B',
          phone: '0100',
        });
      expect((await pgFailure(badPhone)).constraint).toBe('chk_customers_phone');
    });

    it('at most one live default per customer; a deleted default does not count', async () => {
      const { customerId } = await newCustomer();
      const governorate = await governorateId();
      const [first] = await db('customer_addresses')
        .insert(address(customerId, governorate, { is_default: true }))
        .returning<{ id: string }[]>('id');
      const secondDefault = () =>
        db('customer_addresses').insert(address(customerId, governorate, { is_default: true }));
      expect((await pgFailure(secondDefault)).constraint).toBe('uq_customer_addresses_customer_id_default');

      await db('customer_addresses').where({ id: first?.id }).update({ deleted_at: new Date() });
      await expect(secondDefault()).resolves.toBeDefined();
    });

    it('the governorate FK is enforced and restricts deleting a used governorate', async () => {
      const { customerId } = await newCustomer();
      const unknown = '0192f5e0-0000-7000-8000-000000000000';
      expect(
        (await pgFailure(() => db('customer_addresses').insert(address(customerId, unknown)))).constraint,
      ).toBe('fk_customer_addresses_governorate_id');
      const governorate = await governorateId();
      await db('customer_addresses').insert(address(customerId, governorate));
      // ON DELETE RESTRICT raises restrict_violation (23001), not foreign_key_violation (23503).
      expect((await pgFailure(() => db('governorates').where({ id: governorate }).delete())).code).toBe(
        '23001',
      );
    });
  });

  describe('sellers + seller_settings', () => {
    const seller = async (overrides: Record<string, unknown> = {}) => ({
      user_id: await insertUser({ role: 'seller' }),
      business_name: `Shop ${randomUUID()}`,
      contact_phone: '+201221234567',
      pickup_governorate_id: (
        await db('governorates').select('id').where({ code: 'EG-C' }).first<{ id: string }>()
      )?.id,
      pickup_city: 'Cairo',
      pickup_area: 'Nasr City',
      pickup_street: 'Street',
      pickup_building: '5',
      status: 'pending_approval',
      commission_rate: '0.1000',
      ...overrides,
    });

    it('business names are unique case-insensitively', async () => {
      await db('sellers').insert(await seller({ business_name: 'Nile Crafts' }));
      expect(
        (await pgFailure(async () => db('sellers').insert(await seller({ business_name: 'NILE crafts' }))))
          .constraint,
      ).toBe('uq_sellers_business_name_lower');
    });

    it('enforces the status whitelist, the rate range and a reason for rejected sellers', async () => {
      const fails = async (overrides: Record<string, unknown>) =>
        (await pgFailure(async () => db('sellers').insert(await seller(overrides)))).constraint;
      expect(await fails({ status: 'banned' })).toBe('chk_sellers_status');
      expect(await fails({ commission_rate: '1.5' })).toBe('chk_sellers_commission_rate');
      expect(await fails({ status: 'rejected' })).toBe('chk_sellers_rejection_reason');
      await expect(
        db('sellers').insert(await seller({ status: 'rejected', rejection_reason: 'Docs' })),
      ).resolves.toBeDefined();
    });

    it('seller_settings holds exactly one seeded row (0.1000)', async () => {
      expect(await db('seller_settings').select('default_commission_rate')).toEqual([
        { default_commission_rate: '0.1000' },
      ]);
      expect(
        (
          await pgFailure(() =>
            db('seller_settings').insert({ is_singleton: true, default_commission_rate: 0.2 }),
          )
        ).constraint,
      ).toBe('uq_seller_settings_is_singleton');
    });
  });

  describe('catalog + inventory (P3)', () => {
    const fx = () => catalogFixtures(db);

    it('category names are unique per parent case-insensitively, root level included; depth 1..3', async () => {
      const { insertCategory } = fx();
      const name = `Phones ${randomUUID()}`;
      const root = await insertCategory({ name });
      expect((await pgFailure(() => insertCategory({ name: name.toUpperCase() }))).constraint).toBe(
        'uq_categories_parent_id_name_lower',
      );
      // The same name under another parent is fine.
      await insertCategory({ parentId: root, depth: 2, name });
      expect((await pgFailure(() => insertCategory({ parentId: root, depth: 4 }))).constraint).toBe(
        'chk_categories_depth',
      );
    });

    it('products: status whitelist, price projections, generated search vector', async () => {
      const { insertSeller, insertCategory, insertProduct } = fx();
      const { sellerId } = await insertSeller();
      const categoryId = await insertCategory();
      const fails = async (overrides: Record<string, unknown>) =>
        (await pgFailure(() => insertProduct(sellerId, categoryId, overrides))).constraint;
      expect(await fails({ status: 'archived' })).toBe('chk_products_status');
      expect(await fails({ min_price: '10.00', max_price: '5.00' })).toBe('chk_products_max_price');
      expect(await fails({ description: 'x'.repeat(5001) })).toBe('chk_products_description');

      const id = await insertProduct(sellerId, categoryId, {
        name: 'Wireless headphones',
        description: 'Bass',
      });
      const row = await db('products')
        .where({ id })
        .first<{ hit: boolean }>(
          db.raw(`search_vector @@ websearch_to_tsquery('english', 'headphone') AS hit`),
        );
      expect(row?.hit).toBe(true);
    });

    it('variants: SKU unique per seller among live rows, one row per option combination', async () => {
      const { insertSeller, insertCategory, insertProduct, insertVariant } = fx();
      const { sellerId } = await insertSeller();
      const productId = await insertProduct(sellerId, await insertCategory());
      const signature = signatureOf([]);
      const first = await insertVariant(productId, sellerId, { sku: 'ABC-1', option_signature: signature });
      expect((await pgFailure(() => insertVariant(productId, sellerId, { sku: 'abc-1' }))).constraint).toBe(
        'uq_product_variants_seller_id_sku_lower',
      );
      expect(
        (await pgFailure(() => insertVariant(productId, sellerId, { option_signature: signature })))
          .constraint,
      ).toBe('uq_product_variants_product_id_option_signature');
      // Soft-deleting frees the SKU and the combination.
      await db('product_variants').where({ id: first }).update({ deleted_at: db.fn.now() });
      await insertVariant(productId, sellerId, { sku: 'abc-1', option_signature: signature });

      const fails = async (overrides: Record<string, unknown>) =>
        (await pgFailure(() => insertVariant(productId, sellerId, overrides))).constraint;
      expect(await fails({ price: '0.00' })).toBe('chk_product_variants_price');
      expect(await fails({ price: '10.00', compare_at_price: '10.00' })).toBe(
        'chk_product_variants_compare_at_price',
      );
      expect(await fails({ status: 'draft' })).toBe('chk_product_variants_status');
    });

    it('an option used by a variant cannot be deleted (23001, P3-Q11)', async () => {
      const { insertVariantChain } = fx();
      const { categoryId, variantId } = await insertVariantChain();
      const [attribute] = await db('category_attributes')
        .insert({ category_id: categoryId, name: 'Size', code: 'size', sort_order: 0 })
        .returning<{ id: string }[]>('id');
      const [option] = await db('category_attribute_options')
        .insert({ attribute_id: attribute?.id, value: 'XL', code: 'xl', sort_order: 0 })
        .returning<{ id: string }[]>('id');
      await db('variant_attribute_values').insert({
        variant_id: variantId,
        attribute_id: attribute?.id,
        option_id: option?.id,
      });
      expect(
        await pgFailure(() => db('category_attribute_options').where({ id: option?.id }).delete()),
      ).toEqual({
        code: '23001',
        constraint: 'fk_variant_attribute_values_option_id',
      });
      expect(
        (await pgFailure(() => db('category_attributes').where({ id: attribute?.id }).delete())).code,
      ).toBe('23001');
    });

    it('inventory_items: one row per variant, 0 <= reserved <= on_hand', async () => {
      const { insertVariantChain } = fx();
      const { variantId } = await insertVariantChain();
      const fails = async (row: Record<string, unknown>) =>
        (await pgFailure(() => db('inventory_items').insert({ variant_id: variantId, ...row }))).constraint;
      expect(await fails({ on_hand: -1, reserved: 0 })).toBe('chk_inventory_items_on_hand');
      expect(await fails({ on_hand: 1, reserved: 2 })).toBe('chk_inventory_items_reserved_lte_on_hand');
      const [item] = await db('inventory_items')
        .insert({ variant_id: variantId, on_hand: 5, reserved: 0 })
        .returning<{ id: string }[]>('id');
      expect(await fails({ on_hand: 1, reserved: 0 })).toBe('uq_inventory_items_variant_id');
      expect(
        (
          await pgFailure(() =>
            db('inventory_movements').insert({
              inventory_item_id: item?.id,
              type: 'restock',
              quantity_delta: 1,
              on_hand_after: 6,
              reserved_after: 0,
            }),
          )
        ).constraint,
      ).toBe('chk_inventory_movements_type');
    });

    it('listing and stock-history indexes match D-5, D-6 and D-7', async () => {
      const definitions = await db.raw<{ rows: { name: string; definition: string }[] }>(
        `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname IN ('idx_products_category_id_published_at_id', 'idx_products_published_at_id',
                              'idx_inventory_movements_inventory_item_id_created_at_id',
                              'idx_products_category_id')
          ORDER BY c.relname`,
      );
      const byName = Object.fromEntries(definitions.rows.map((row) => [row.name, row.definition]));
      expect(byName.idx_products_category_id_published_at_id).toMatch(
        /\(category_id, published_at DESC, id DESC\) WHERE.*status.*'active'.*seller_active.*deleted_at IS NULL/,
      );
      expect(byName.idx_products_published_at_id).toMatch(/\(published_at DESC, id DESC\) WHERE/);
      // D-7: not partial, so drafts and deleted products are covered too.
      expect(byName.idx_products_category_id).toMatch(/\(category_id\)$/);
      expect(byName.idx_inventory_movements_inventory_item_id_created_at_id).toMatch(
        /\(inventory_item_id, created_at DESC, id DESC\)/,
      );
    });
  });

  describe('carts + cart_items (P4)', () => {
    const fx = () => cartFixtures(db);

    it('one cart per customer; the customer FK restricts deletes', async () => {
      const { insertCustomer, insertCart } = fx();
      const { customerId } = await insertCustomer();
      await insertCart(customerId);
      expect((await pgFailure(() => insertCart(customerId))).constraint).toBe('uq_carts_customer_id');
      expect((await pgFailure(() => insertCart(randomUUID()))).constraint).toBe('fk_carts_customer_id');
      expect(await pgFailure(() => db('customers').where({ id: customerId }).delete())).toEqual({
        code: '23001',
        constraint: 'fk_carts_customer_id',
      });
    });

    it('quantity 1..99, one line per variant; deleting the cart cascades to its lines', async () => {
      const { insertCustomer, insertCart, insertCartItem, insertVariantChain } = fx();
      const { customerId } = await insertCustomer();
      const cartId = await insertCart(customerId);
      const { variantId } = await insertVariantChain();
      for (const quantity of [0, 100]) {
        expect((await pgFailure(() => insertCartItem(cartId, variantId, quantity))).constraint).toBe(
          'chk_cart_items_quantity',
        );
      }
      await insertCartItem(cartId, variantId, 99);
      expect((await pgFailure(() => insertCartItem(cartId, variantId, 1))).constraint).toBe(
        'uq_cart_items_cart_id_variant_id',
      );
      expect((await pgFailure(() => insertCartItem(cartId, randomUUID(), 1))).constraint).toBe(
        'fk_cart_items_variant_id',
      );
      expect(await pgFailure(() => db('product_variants').where({ id: variantId }).delete())).toEqual({
        code: '23001',
        constraint: 'fk_cart_items_variant_id',
      });

      await db('carts').where({ id: cartId }).delete();
      expect(await db('cart_items').where({ cart_id: cartId }).count<{ count: string }[]>('*')).toEqual([
        { count: '0' },
      ]);
    });

    it('business columns have no defaults (G13)', async () => {
      const { insertCustomer, insertCart, insertVariantChain } = fx();
      const cartId = await insertCart((await insertCustomer()).customerId);
      const { variantId } = await insertVariantChain();
      expect(
        (await pgFailure(() => db('cart_items').insert({ cart_id: cartId, variant_id: variantId }))).code,
      ).toBe('23502');
    });
  });

  describe('ordering + payments + reservations (P5)', () => {
    const fx = () => orderFixtures(db);

    it('orders: NM- numbers from the sequence, unique; total = items + fee; payment window only for Kashier', async () => {
      const { insertCustomer, insertOrder, nextOrderNumber } = fx();
      const { customerId } = await insertCustomer();
      const number = await nextOrderNumber();
      expect(number).toMatch(/^NM-\d{9}$/);
      await insertOrder(customerId, { order_number: number });
      expect((await pgFailure(() => insertOrder(customerId, { order_number: number }))).constraint).toBe(
        'uq_orders_order_number',
      );
      expect((await pgFailure(() => insertOrder(customerId, { order_number: 'ORD-1' }))).constraint).toBe(
        'chk_orders_order_number',
      );
      expect((await pgFailure(() => insertOrder(customerId, { total: '149.99' }))).constraint).toBe(
        'chk_orders_total',
      );
      expect((await pgFailure(() => insertOrder(customerId, { status: 'shipped' }))).constraint).toBe(
        'chk_orders_status',
      );
      expect(
        (
          await pgFailure(() =>
            insertOrder(customerId, { payment_method: 'kashier', payment_expires_at: null }),
          )
        ).constraint,
      ).toBe('chk_orders_payment_expires_at');
      expect(
        (await pgFailure(() => insertOrder(customerId, { payment_expires_at: new Date() }))).constraint,
      ).toBe('chk_orders_payment_expires_at');
      await insertOrder(customerId, {
        status: 'pending_payment',
        payment_method: 'kashier',
        payment_expires_at: new Date(),
        placed_at: null,
      });
      expect(await pgFailure(() => db('customers').where({ id: customerId }).delete())).toEqual({
        code: '23001',
        constraint: 'fk_orders_customer_id',
      });
    });

    it('seller_orders: one per seller per order; net = subtotal - commission; cancelled ⇔ reason and time', async () => {
      const { insertOrderChain, insertSellerOrder } = fx();
      const { orderId, sellerId } = await insertOrderChain();
      expect((await pgFailure(() => insertSellerOrder(orderId, sellerId))).constraint).toBe(
        'uq_seller_orders_order_id_seller_id',
      );
      const other = (await fx().insertSeller()).sellerId;
      expect(
        (await pgFailure(() => insertSellerOrder(orderId, other, { seller_net: '91.00' }))).constraint,
      ).toBe('chk_seller_orders_net');
      expect(
        (await pgFailure(() => insertSellerOrder(orderId, other, { status: 'cancelled' }))).constraint,
      ).toBe('chk_seller_orders_cancelled');
      expect(
        (await pgFailure(() => insertSellerOrder(orderId, other, { cancel_reason: 'seller_cancelled' })))
          .constraint,
      ).toBe('chk_seller_orders_cancelled');
      expect(
        (
          await pgFailure(() =>
            insertSellerOrder(orderId, other, {
              status: 'cancelled',
              cancel_reason: 'changed_mind',
              cancelled_at: new Date(),
            }),
          )
        ).constraint,
      ).toBe('chk_seller_orders_cancel_reason');
      await insertSellerOrder(orderId, other, {
        status: 'cancelled',
        cancel_reason: 'seller_acceptance_timeout',
        cancelled_at: new Date(),
      });
    });

    it('order_items: line_total follows the open quantity; snapshots are arrays; variants restrict deletes', async () => {
      const { insertOrderChain, insertOrderItem } = fx();
      const { sellerOrderId, variantId, productId } = await insertOrderChain();
      const variant = { variantId, productId };
      expect(
        (await pgFailure(() => insertOrderItem(sellerOrderId, variant, { line_total: '99.00' }))).constraint,
      ).toBe('chk_order_items_line_total');
      expect(
        (
          await pgFailure(() =>
            insertOrderItem(sellerOrderId, variant, { cancelled_quantity: 3, line_total: '-50.00' }),
          )
        ).constraint,
      ).toBe('chk_order_items_cancelled_quantity');
      expect(
        (
          await pgFailure(() =>
            insertOrderItem(sellerOrderId, variant, { variant_attributes: JSON.stringify({}) }),
          )
        ).constraint,
      ).toBe('chk_order_items_variant_attributes');
      await insertOrderItem(sellerOrderId, variant, { cancelled_quantity: 1, line_total: '50.00' });
      expect(await pgFailure(() => db('product_variants').where({ id: variantId }).delete())).toEqual({
        code: '23001',
        constraint: 'fk_order_items_variant_id',
      });
    });

    it('order_item_cancellations need a note when the reason is other', async () => {
      const { insertOrderChain, insertUser } = fx();
      const { orderItemId } = await insertOrderChain();
      const actorUserId = await insertUser('seller');
      const cancel = (row: Record<string, unknown>) =>
        db('order_item_cancellations').insert({
          order_item_id: orderItemId,
          actor_user_id: actorUserId,
          ...row,
        });
      expect((await pgFailure(() => cancel({ quantity: 1, reason: 'other', note: null }))).constraint).toBe(
        'chk_order_item_cancellations_note',
      );
      expect(
        (await pgFailure(() => cancel({ quantity: 0, reason: 'out_of_stock', note: null }))).constraint,
      ).toBe('chk_order_item_cancellations_quantity');
      await cancel({ quantity: 1, reason: 'other', note: 'Damaged in storage' });
    });

    it('status histories: whitelisted statuses and roles; the system actor has no user', async () => {
      const { insertOrderChain, insertUser } = fx();
      const { orderId, sellerOrderId } = await insertOrderChain();
      const userId = await insertUser('customer');
      expect(
        (
          await pgFailure(() =>
            db('order_status_history').insert({
              order_id: orderId,
              from_status: null,
              to_status: 'placed',
              actor_role: 'system',
              actor_user_id: userId,
              reason: null,
            }),
          )
        ).constraint,
      ).toBe('chk_order_status_history_system_actor');
      expect(
        (
          await pgFailure(() =>
            db('seller_order_status_history').insert({
              seller_order_id: sellerOrderId,
              from_status: 'placed',
              to_status: 'shipped',
              actor_role: 'seller',
              actor_user_id: null,
              reason: null,
            }),
          )
        ).constraint,
      ).toBe('chk_seller_order_status_history_to_status');
      await db('seller_order_status_history').insert({
        seller_order_id: sellerOrderId,
        from_status: null,
        to_status: 'placed',
        actor_role: 'customer',
        actor_user_id: userId,
        reason: null,
      });
    });

    it('inventory_reservations: one per order line; released ⇔ nothing left reserved', async () => {
      const { insertOrderChain, insertInventoryItem } = fx();
      const { orderItemId, variantId } = await insertOrderChain();
      const inventoryItemId = await insertInventoryItem(variantId, 10, 2);
      const reserve = (row: Record<string, unknown>) =>
        db('inventory_reservations').insert({
          inventory_item_id: inventoryItemId,
          order_item_id: orderItemId,
          ...row,
        });
      expect((await pgFailure(() => reserve({ quantity: 0, status: 'active' }))).constraint).toBe(
        'chk_inventory_reservations_released',
      );
      expect((await pgFailure(() => reserve({ quantity: 2, status: 'released' }))).constraint).toBe(
        'chk_inventory_reservations_released',
      );
      expect((await pgFailure(() => reserve({ quantity: -1, status: 'active' }))).constraint).toBe(
        'chk_inventory_reservations_quantity',
      );
      await reserve({ quantity: 2, status: 'active' });
      expect((await pgFailure(() => reserve({ quantity: 1, status: 'active' }))).constraint).toBe(
        'uq_inventory_reservations_order_item_id',
      );
      await db('inventory_reservations')
        .where({ order_item_id: orderItemId })
        .update({ quantity: 0, status: 'released', updated_at: db.fn.now() });
    });

    it('payments: one per order, statuses per method, refunds within collected, sessions stored whole', async () => {
      const { insertOrderChain, insertPayment, insertCustomer, insertOrder } = fx();
      const { orderId } = await insertOrderChain();
      expect((await pgFailure(() => insertPayment(orderId, { status: 'paid' }))).constraint).toBe(
        'chk_payments_status',
      );
      expect(
        (
          await pgFailure(() =>
            insertPayment(orderId, { collected_amount: '10.00', refunded_amount: '10.01' }),
          )
        ).constraint,
      ).toBe('chk_payments_refunded_amount');
      // COD payments never have a Kashier session.
      expect(
        (
          await pgFailure(() =>
            insertPayment(orderId, {
              provider_order_ref: 'sess-1',
              provider_session_url: 'https://pay.example/s/1',
              provider_session_expires_at: new Date(),
            }),
          )
        ).constraint,
      ).toBe('chk_payments_session_columns');
      await insertPayment(orderId);
      expect((await pgFailure(() => insertPayment(orderId))).constraint).toBe('uq_payments_order_id');

      const kashierOrder = async () =>
        insertOrder((await insertCustomer()).customerId, {
          status: 'pending_payment',
          payment_method: 'kashier',
          payment_expires_at: new Date(),
          placed_at: null,
        });
      const kashier = { method: 'kashier', status: 'initiated' };
      expect(
        (
          await pgFailure(async () =>
            insertPayment(await kashierOrder(), { ...kashier, provider_order_ref: 'sess-2' }),
          )
        ).constraint,
      ).toBe('chk_payments_session_columns');
      const session = (ref: string) => ({
        ...kashier,
        provider_order_ref: ref,
        provider_session_url: `https://pay.example/s/${ref}`,
        provider_session_expires_at: new Date(),
      });
      await insertPayment(await kashierOrder(), session('sess-3'));
      expect(
        (await pgFailure(async () => insertPayment(await kashierOrder(), session('sess-3')))).constraint,
      ).toBe('uq_payments_provider_order_ref');
    });

    it('payment_refunds: positive amounts, amount_mismatch allowed, recorded ⇔ who, when and the Kashier ref', async () => {
      const { insertOrderChain, insertPayment, insertUser } = fx();
      const { orderId } = await insertOrderChain();
      const paymentId = await insertPayment(orderId);
      const adminId = await insertUser('admin');
      const refund = (row: Record<string, unknown>) =>
        db('payment_refunds').insert({
          payment_id: paymentId,
          seller_order_id: null,
          amount: '10.00',
          reason: 'amount_mismatch',
          status: 'pending_manual',
          recorded_by_user_id: null,
          recorded_at: null,
          provider_refund_ref: null,
          ...row,
        });
      expect((await pgFailure(() => refund({ amount: '0.00' }))).constraint).toBe(
        'chk_payment_refunds_amount',
      );
      expect((await pgFailure(() => refund({ reason: 'goodwill' }))).constraint).toBe(
        'chk_payment_refunds_reason',
      );
      expect((await pgFailure(() => refund({ status: 'recorded' }))).constraint).toBe(
        'chk_payment_refunds_recorded',
      );
      expect((await pgFailure(() => refund({ recorded_by_user_id: adminId }))).constraint).toBe(
        'chk_payment_refunds_recorded',
      );
      await refund({});
      await refund({
        status: 'recorded',
        recorded_by_user_id: adminId,
        recorded_at: new Date(),
        provider_refund_ref: 'rf-1',
      });
    });

    it('payment_events: deduped per provider event id; payloads are objects', async () => {
      const event = (row: Record<string, unknown>) =>
        db('payment_events').insert({
          payment_id: null,
          provider: 'kashier',
          provider_event_id: 'pay:tx-1:SUCCESS',
          event_type: 'pay',
          payload: JSON.stringify({ event: 'pay' }),
          signature_valid: true,
          processed_at: null,
          ...row,
        });
      expect((await pgFailure(() => event({ payload: JSON.stringify([]) }))).constraint).toBe(
        'chk_payment_events_payload',
      );
      expect((await pgFailure(() => event({ provider: 'paymob' }))).constraint).toBe(
        'chk_payment_events_provider',
      );
      await event({});
      expect((await pgFailure(() => event({}))).constraint).toBe(
        'uq_payment_events_provider_provider_event_id',
      );
    });

    it('business columns have no defaults (G13)', async () => {
      const { insertOrderChain, insertCustomer } = fx();
      const { orderId, sellerOrderId } = await insertOrderChain();
      const { customerId } = await insertCustomer();
      expect(
        (
          await pgFailure(() =>
            db('orders').insert({ order_number: 'NM-999999999', customer_id: customerId }),
          )
        ).code,
      ).toBe('23502');
      expect((await pgFailure(() => db('payments').insert({ order_id: orderId, method: 'cod' }))).code).toBe(
        '23502',
      );
      expect(
        (await pgFailure(() => db('order_items').insert({ seller_order_id: sellerOrderId, quantity: 1 })))
          .code,
      ).toBe('23502');
    });

    it('D-8 indexes exist and serve the admin order list and the refund queue without a sort', async () => {
      const definitions = await db.raw<{ rows: { name: string; definition: string }[] }>(
        `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname IN ('idx_orders_created_at_id', 'idx_payment_events_payment_id',
                              'idx_payment_refunds_created_at_id', 'idx_orders_payment_expires_at',
                              'idx_seller_orders_accept_deadline_at')`,
      );
      const byName = Object.fromEntries(definitions.rows.map((row) => [row.name, row.definition]));
      expect(byName.idx_orders_created_at_id).toMatch(/\(created_at DESC, id DESC\)$/);
      expect(byName.idx_payment_events_payment_id).toMatch(/\(payment_id\)$/);
      expect(byName.idx_payment_refunds_created_at_id).toMatch(/\(created_at, id\) WHERE.*'pending_manual'/);
      expect(byName.idx_orders_payment_expires_at).toMatch(/\(payment_expires_at\) WHERE.*'pending_payment'/);
      expect(byName.idx_seller_orders_accept_deadline_at).toMatch(/\(accept_deadline_at\) WHERE.*'placed'/);

      const planOf = (sql: string) =>
        db.transaction(async (trx) => {
          await trx.raw('SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off');
          const result = await trx.raw<{ rows: { 'QUERY PLAN': string }[] }>(`EXPLAIN ${sql}`);
          return result.rows.map((row) => row['QUERY PLAN']).join('\n');
        });
      const adminList = await planOf(
        `SELECT id FROM orders WHERE (created_at, id) < (now(), '0192f5e0-0000-7000-8000-000000000000')
          ORDER BY created_at DESC, id DESC LIMIT 21`,
      );
      expect(adminList).toContain('idx_orders_created_at_id');
      expect(adminList).not.toContain('Sort');
      const refundQueue = await planOf(
        `SELECT id FROM payment_refunds WHERE status = 'pending_manual'
          ORDER BY created_at, id LIMIT 21`,
      );
      expect(refundQueue).toContain('idx_payment_refunds_created_at_id');
      expect(refundQueue).not.toContain('Sort');
    });
  });

  describe('delivery agents, shipments, attempts and history (P6)', () => {
    const fx = () => deliveryFixtures(db);

    it('delivery_agents: one per user, E.164 phone, an inactive agent is never on shift', async () => {
      const { insertAgent, insertUser } = fx();
      const { userId } = await insertAgent();
      const again = () =>
        db('delivery_agents').insert({
          user_id: userId,
          full_name: 'Twice',
          phone: '+201101234567',
          home_governorate_id: db('governorates').select('id').where({ code: 'EG-C' }),
          status: 'active',
          on_shift: false,
          last_assigned_at: null,
        });
      expect((await pgFailure(again)).constraint).toBe('uq_delivery_agents_user_id');
      const fresh = async (overrides: Record<string, unknown>) =>
        insertAgent({ user_id: await insertUser('delivery_agent'), ...overrides });
      expect((await pgFailure(() => fresh({ phone: '0101234567' }))).constraint).toBe(
        'chk_delivery_agents_phone',
      );
      expect((await pgFailure(() => fresh({ status: 'inactive', on_shift: true }))).constraint).toBe(
        'chk_delivery_agents_on_shift',
      );
      expect((await pgFailure(() => fresh({ status: 'retired' }))).constraint).toBe(
        'chk_delivery_agents_status',
      );
      await fresh({ status: 'inactive', on_shift: false });
    });

    it('shipments: one per seller order, snapshots required, agent rules per status', async () => {
      const { insertShipmentChain, insertShipment, insertAgent } = fx();
      const { sellerOrderId, orderId, shipmentId } = await insertShipmentChain();
      expect((await pgFailure(() => insertShipment({ sellerOrderId, orderId }))).constraint).toBe(
        'uq_shipments_seller_order_id',
      );
      const { agentId } = await insertAgent();
      const set = (values: Record<string, unknown>) =>
        db('shipments').where({ id: shipmentId }).update(values);
      expect((await pgFailure(() => set({ agent_id: agentId }))).constraint).toBe('chk_shipments_agent');
      expect((await pgFailure(() => set({ status: 'assigned' }))).constraint).toBe('chk_shipments_agent');
      await set({ status: 'assigned', agent_id: agentId, assigned_at: new Date() });
      expect((await pgFailure(() => set({ status: 'delivered' }))).constraint).toBe(
        'chk_shipments_delivered',
      );
      await set({ status: 'cancelled' }); // cancelled may keep its agent
      expect((await pgFailure(() => set({ attempt_count: 4 }))).constraint).toBe(
        'chk_shipments_attempt_count',
      );
      expect((await pgFailure(() => set({ status: 'lost' }))).constraint).toBe('chk_shipments_status');
      expect(
        (await pgFailure(() => db('shipments').insert({ seller_order_id: sellerOrderId, order_id: orderId })))
          .code,
      ).toBe('23502');
    });

    it('fee carrier: holds exactly the checkout fee; at most one per checkout; Kashier collects nothing', async () => {
      const { insertShipmentChain, insertShipment, insertSellerOrder, insertSeller } = fx();
      const first = await insertShipmentChain();
      const carry = (id: string, fee: string) =>
        db('shipments').where({ id }).update({ carries_delivery_fee: true, cod_fee_amount: fee });
      expect((await pgFailure(() => carry(first.shipmentId, '49.00'))).constraint).toBe(
        'chk_shipments_fee_carrier',
      );
      expect(
        (
          await pgFailure(() =>
            db('shipments').where({ id: first.shipmentId }).update({ cod_fee_amount: '1.00' }),
          )
        ).constraint,
      ).toBe('chk_shipments_fee_carrier');
      await carry(first.shipmentId, '50.00');

      const sibling = await insertSellerOrder(first.orderId, (await insertSeller()).sellerId);
      const siblingShipment = await insertShipment({ sellerOrderId: sibling, orderId: first.orderId });
      expect((await pgFailure(() => carry(siblingShipment, '50.00'))).constraint).toBe(
        'uq_shipments_order_id_fee_carrier',
      );

      const kashier = await fx().insertShipmentChain({
        payment_method: 'kashier',
        order_delivery_fee: '0.00',
        cod_items_amount: '0.00',
      });
      expect(
        (
          await pgFailure(() =>
            db('shipments').where({ id: kashier.shipmentId }).update({ cod_items_amount: '10.00' }),
          )
        ).constraint,
      ).toBe('chk_shipments_kashier_no_cash');
      expect(
        (
          await pgFailure(() =>
            db('shipments').where({ id: kashier.shipmentId }).update({ cod_collected_amount: '0.00' }),
          )
        ).constraint,
      ).toBe('chk_shipments_kashier_no_cash');
    });

    it('shipment_attempts: numbers 1..3, unique per shipment, whitelisted reasons; history whitelists', async () => {
      const { insertShipmentChain, insertAgent } = fx();
      const { shipmentId } = await insertShipmentChain();
      const { agentId } = await insertAgent();
      const attempt = (row: Record<string, unknown>) =>
        db('shipment_attempts').insert({ shipment_id: shipmentId, agent_id: agentId, note: null, ...row });
      expect(
        (await pgFailure(() => attempt({ attempt_number: 4, reason: 'wrong_address' }))).constraint,
      ).toBe('chk_shipment_attempts_attempt_number');
      expect((await pgFailure(() => attempt({ attempt_number: 1, reason: 'rain' }))).constraint).toBe(
        'chk_shipment_attempts_reason',
      );
      await attempt({ attempt_number: 1, reason: 'customer_unreachable' });
      expect(
        (await pgFailure(() => attempt({ attempt_number: 1, reason: 'wrong_address' }))).constraint,
      ).toBe('uq_shipment_attempts_shipment_id_attempt_number');

      const history = (row: Record<string, unknown>) =>
        db('shipment_status_history').insert({
          shipment_id: shipmentId,
          from_status: null,
          reason: null,
          ...row,
        });
      expect(
        (await pgFailure(() => history({ to_status: 'lost', actor_role: 'system', actor_user_id: null })))
          .constraint,
      ).toBe('chk_shipment_status_history_to_status');
      const adminId = await fx().insertUser('admin');
      expect(
        (
          await pgFailure(() =>
            history({ to_status: 'assigned', actor_role: 'system', actor_user_id: adminId }),
          )
        ).constraint,
      ).toBe('chk_shipment_status_history_system_actor');
      await history({ to_status: 'unassigned', actor_role: 'system', actor_user_id: null });
    });

    it('D-3 / D-10 indexes exist and serve the admin, agent and retry lists without a sort', async () => {
      const definitions = await db.raw<{ rows: { name: string; definition: string }[] }>(
        `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname IN ('idx_shipments_status_created_at_id', 'idx_shipments_created_at_desc_id',
                              'idx_shipments_agent_id_created_at_id', 'idx_shipments_created_at_id',
                              'idx_delivery_agents_created_at_id', 'uq_shipments_order_id_fee_carrier')`,
      );
      const byName = Object.fromEntries(definitions.rows.map((row) => [row.name, row.definition]));
      expect(byName.idx_shipments_status_created_at_id).toMatch(/\(status, created_at DESC, id DESC\)$/);
      expect(byName.idx_shipments_created_at_desc_id).toMatch(/\(created_at DESC, id DESC\)$/);
      expect(byName.idx_shipments_agent_id_created_at_id).toMatch(
        /\(agent_id, created_at, id\) WHERE \(agent_id IS NOT NULL\)/,
      );
      expect(byName.idx_shipments_created_at_id).toMatch(/\(created_at, id\) WHERE.*'unassigned'/);
      expect(byName.idx_delivery_agents_created_at_id).toMatch(/\(created_at DESC, id DESC\)$/);
      expect(byName.uq_shipments_order_id_fee_carrier).toMatch(
        /UNIQUE.*\(order_id\) WHERE carries_delivery_fee/,
      );

      const planOf = (sql: string) =>
        db.transaction(async (trx) => {
          await trx.raw('SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off');
          const result = await trx.raw<{ rows: { 'QUERY PLAN': string }[] }>(`EXPLAIN ${sql}`);
          return result.rows.map((row) => row['QUERY PLAN']).join('\n');
        });
      for (const [sql, index] of [
        [
          `SELECT id FROM shipments ORDER BY created_at DESC, id DESC LIMIT 21`,
          'idx_shipments_created_at_desc_id',
        ],
        [
          `SELECT id FROM shipments WHERE agent_id = '0192f5e0-0000-7000-8000-000000000000' ORDER BY created_at, id LIMIT 21`,
          'idx_shipments_agent_id_created_at_id',
        ],
        [
          `SELECT id FROM shipments WHERE status = 'unassigned' ORDER BY created_at, id LIMIT 100`,
          'idx_shipments_created_at_id',
        ],
      ] as const) {
        const plan = await planOf(sql);
        expect(plan).toContain(index);
        expect(plan).not.toContain('Sort');
      }
    });
  });
});
