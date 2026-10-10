import { randomUUID } from 'node:crypto';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDownAll, migrateLatest } from '../../src/lib/db/migrator';
import { MIGRATIONS } from '../../src/migrations';
import { catalogFixtures, signatureOf } from '../helpers/catalog-fixtures';
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
});
