'use strict';
// Usage: npm run perf:seed   (local docker-compose database only; plan §10 step 6, P8-Q13)
// Fills the local database toward the design horizon (CLAUDE.md §15) for the load-test baseline:
// 2k approved sellers, 100k active products in 20 leaf categories with a `size` attribute (3 variants
// each, 300k variants, ample stock), 100k customers with a Cairo address, 200k placed COD orders with
// their seller orders, lines and payments, and 100k ledger entries on the sellers' accounts.
// Then it signs access tokens with the local dev key (2,000 customers, 200 sellers, one admin) and
// writes test/load/.data/perf-data.json for the k6 scenarios (git-ignored).
// Set-based SQL (generate_series) with pre-generated UUID v7 ids, so it runs in a few minutes.
// Runs once per database: start from a fresh volume (`docker compose down -v`) to seed again.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const { Redis } = require('ioredis');
const { importPKCS8, SignJWT } = require('jose');

const COUNTS = {
  sellers: 2_000,
  products: 100_000,
  customers: 100_000,
  orders: 200_000,
  ledgerPerSeller: 50,
};
const TOKENS = { customers: 2_000, sellers: 200, hours: 6 };
const LEAVES_PER_ROOT = 5;
const ROOTS = ['Perf Electronics', 'Perf Fashion', 'Perf Home', 'Perf Sports'];
const SIZES = ['S', 'M', 'L'];
const DATA_FILE = path.join(__dirname, '..', 'test', 'load', '.data', 'perf-data.json');
// Must match src/app/catalog/constants.ts.
const CATEGORY_TREE_CACHE_KEY = 'v1:catalog:category-tree';
// A bcrypt-shaped placeholder: nobody logs in with a password, the load test uses signed tokens.
// 60 characters like a real hash (users.password_hash is VARCHAR(60)); bcrypt matches nothing with it.
const NO_LOGIN_HASH = '$2b$12$' + 'perfseed'.repeat(7).slice(0, 53);

// Words for product names (test/load/vocabulary.json): varied enough that a word matches ~0.5 % of
// the catalog, so search and typos behave like a real marketplace.
const VOCABULARY = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'test', 'load', 'vocabulary.json'), 'utf8'),
);
const ADJECTIVES = VOCABULARY.adjectives;
const NOUNS = VOCABULARY.nouns;
const BRANDS = VOCABULARY.brands;

function requireEnv(key) {
  const value = process.env[key];
  if (value === undefined) {
    console.error(`perf-seed: missing env ${key}`);
    process.exit(1);
  }
  return value;
}

const step = async (label, run) => {
  const started = Date.now();
  const result = await run();
  console.log(`perf-seed: ${label} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  return result;
};

const sqlArray = (values) => `ARRAY[${values.map((v) => `'${v}'`).join(',')}]`;

async function seedCategories(trx) {
  const leaves = [];
  {
    for (const [r, rootName] of ROOTS.entries()) {
      const [root] = await trx('categories')
        .insert({
          parent_id: null,
          name: rootName,
          slug: `perf-root-${r + 1}`,
          depth: 1,
          sort_order: r,
          is_active: true,
        })
        .returning('id');
      for (let c = 1; c <= LEAVES_PER_ROOT; c += 1) {
        const [leaf] = await trx('categories')
          .insert({
            parent_id: root.id,
            name: `${rootName} ${c}`,
            slug: `perf-leaf-${r + 1}-${c}`,
            depth: 2,
            sort_order: c,
            is_active: true,
          })
          .returning('id');
        const [attribute] = await trx('category_attributes')
          .insert({ category_id: leaf.id, name: 'Size', code: 'size', sort_order: 0 })
          .returning('id');
        const options = await trx('category_attribute_options')
          .insert(
            SIZES.map((value, i) => ({
              attribute_id: attribute.id,
              value,
              code: value.toLowerCase(),
              sort_order: i,
            })),
          )
          .returning(['id', 'code']);
        leaves.push({ id: leaf.id, attributeId: attribute.id, options });
      }
    }
  }
  return leaves;
}

async function main() {
  if (requireEnv('NODE_ENV') !== 'development') {
    console.error('perf-seed: refusing to run outside NODE_ENV=development');
    process.exit(1);
  }
  // One connection: the temp tables below live in its session.
  const knexDb = knex({ client: 'pg', connection: requireEnv('DATABASE_URL'), pool: { min: 1, max: 1 } });
  try {
    if (await knexDb('categories').where({ slug: 'perf-root-1' }).first('id')) {
      console.error(
        'perf-seed: perf data already present; start from a fresh volume (docker compose down -v)',
      );
      process.exit(1);
    }
    const cairo = await knexDb('governorates').where({ code: 'EG-C' }).first('id', 'name', 'delivery_fee');
    if (!cairo || cairo.delivery_fee === null) {
      console.error('perf-seed: Cairo has no delivery fee: run `npm run seed:dev` first');
      process.exit(1);
    }
    const fee = cairo.delivery_fee;

    // Everything in one transaction: a failure leaves nothing behind.
    const admin = await knexDb.transaction(async (db) => {
      const leaves = await step('categories', () => seedCategories(db));
      await db.raw(
        `CREATE TEMP TABLE perf_leaf_options (leaf_n int, leaf_id uuid, attribute_id uuid, idx int, option_id uuid)`,
      );
      await db('perf_leaf_options').insert(
        leaves.flatMap((leaf, n) =>
          SIZES.map((size, idx) => ({
            leaf_n: n,
            leaf_id: leaf.id,
            attribute_id: leaf.attributeId,
            idx,
            option_id: leaf.options.find((o) => o.code === size.toLowerCase()).id,
          })),
        ),
      );

      const [admin] = await db('users')
        .insert({
          email: 'perf-admin@perf.nile.test',
          password_hash: NO_LOGIN_HASH,
          role: 'admin',
          status: 'active',
          email_verified_at: db.fn.now(),
        })
        .returning('id');

      await step(`${COUNTS.sellers} sellers`, async () => {
        await db.raw(
          `CREATE TEMP TABLE ps AS SELECT n, uuidv7() AS user_id, uuidv7() AS id FROM generate_series(1, ?) n`,
          [COUNTS.sellers],
        );
        await db.raw(
          `INSERT INTO users (id, email, password_hash, role, status, email_verified_at)
         SELECT user_id, 'perf-seller-' || n || '@perf.nile.test', ?, 'seller', 'active', now() FROM ps`,
          [NO_LOGIN_HASH],
        );
        await db.raw(
          `INSERT INTO sellers (id, user_id, business_name, contact_phone, pickup_governorate_id, pickup_city, pickup_area,
           pickup_street, pickup_building, pickup_landmark, status, commission_rate, rejection_reason, approved_at, created_at)
         SELECT id, user_id, 'Perf Shop ' || n, '+20122' || lpad(n::text, 7, '0'), ?, 'Cairo', 'Nasr City',
           'Street ' || n, '5', NULL, 'approved', 0.1000, NULL, now(), now() - n * interval '1 minute'
         FROM ps`,
          [cairo.id],
        );
      });

      await step(`${COUNTS.products} products`, async () => {
        const adjectives = sqlArray(ADJECTIVES);
        const nouns = sqlArray(NOUNS);
        const brands = sqlArray(BRANDS);
        await db.raw(
          `CREATE TEMP TABLE pp AS
         SELECT g.n AS n, uuidv7() AS id, ps.id AS seller_id, (g.n % ?) AS leaf_n, (50 + (g.n % 950))::numeric(12,2) AS base_price,
           (${adjectives})[1 + (g.n * 7) % ${ADJECTIVES.length}] || ' ' || (${nouns})[1 + (g.n * 13) % ${NOUNS.length}] || ' '
             || (${brands})[1 + (g.n * 3) % ${BRANDS.length}] || ' ' || (g.n % 1000) AS name
         FROM generate_series(1, ?) AS g(n) JOIN ps ON ps.n = ((g.n - 1) % ?) + 1`,
          [leaves.length, COUNTS.products, COUNTS.sellers],
        );
        await db.raw(
          `INSERT INTO products (id, seller_id, category_id, name, slug, description, status, seller_active,
           min_price, max_price, in_stock, published_at, created_at)
         SELECT pp.id, pp.seller_id, lo.leaf_id, pp.name, 'perf-product-' || pp.n,
           'Load-test product ' || pp.n || ': ' || pp.name || ', made for everyday use.', 'active', true,
           pp.base_price, pp.base_price + 20, true, now() - pp.n * interval '30 seconds', now() - pp.n * interval '30 seconds'
         FROM pp JOIN perf_leaf_options lo ON lo.leaf_n = pp.leaf_n AND lo.idx = 0`,
        );
      });

      await step(`${COUNTS.products * SIZES.length} variants, options and stock`, async () => {
        await db.raw(
          `CREATE TEMP TABLE pv AS
         SELECT uuidv7() AS id, pp.n AS product_n, pp.id AS product_id, pp.seller_id, lo.idx, lo.attribute_id, lo.option_id,
           pp.base_price + lo.idx * 10 AS price
         FROM pp JOIN perf_leaf_options lo ON lo.leaf_n = pp.leaf_n`,
        );
        // option_signature = sha256 hex of the sorted option ids joined by ',' (one option here).
        await db.raw(
          `INSERT INTO product_variants (id, product_id, seller_id, sku, price, compare_at_price, status, option_signature, is_default)
         SELECT id, product_id, seller_id, 'PERF-' || product_n || '-' || idx, price, NULL, 'active',
           encode(sha256(convert_to(option_id::text, 'UTF8')), 'hex'), false
         FROM pv`,
        );
        await db.raw(
          `INSERT INTO variant_attribute_values (variant_id, attribute_id, option_id) SELECT id, attribute_id, option_id FROM pv`,
        );
        await db.raw(
          `INSERT INTO inventory_items (variant_id, on_hand, reserved) SELECT id, 1000000, 0 FROM pv`,
        );
      });

      await step(`${COUNTS.customers} customers with addresses`, async () => {
        await db.raw(
          `CREATE TEMP TABLE pc AS SELECT n, uuidv7() AS user_id, uuidv7() AS id, uuidv7() AS address_id FROM generate_series(1, ?) n`,
          [COUNTS.customers],
        );
        await db.raw(
          `INSERT INTO users (id, email, password_hash, role, status, email_verified_at)
         SELECT user_id, 'perf-customer-' || n || '@perf.nile.test', ?, 'customer', 'active', now() FROM pc`,
          [NO_LOGIN_HASH],
        );
        await db.raw(
          `INSERT INTO customers (id, user_id, first_name, last_name, phone)
         SELECT id, user_id, 'Perf', 'Customer ' || n, '+20100' || lpad(n::text, 7, '0') FROM pc`,
        );
        await db.raw(
          `INSERT INTO customer_addresses (id, customer_id, governorate_id, label, recipient_name, recipient_phone, city, area,
           street, building, floor, apartment, landmark, is_default, deleted_at)
         SELECT address_id, id, ?, 'Home', 'Perf Customer ' || n, '+20100' || lpad(n::text, 7, '0'), 'Cairo', 'Maadi',
           'Road ' || (n % 300), '12', NULL, NULL, NULL, true, NULL
         FROM pc`,
          [cairo.id],
        );
      });

      await step(`${COUNTS.orders} orders with seller orders, lines and payments`, async () => {
        await db.raw(
          `CREATE TEMP TABLE po AS
         SELECT o.n, uuidv7() AS id, uuidv7() AS seller_order_id, pc.id AS customer_id, pv.id AS variant_id,
           pv.product_id, pv.seller_id, pv.price, pv.product_n, pv.idx
         FROM generate_series(1, ?) o(n)
         JOIN pc ON pc.n = ((o.n - 1) % ?) + 1
         JOIN pv ON pv.product_n = ((o.n * 37) % ?) + 1 AND pv.idx = o.n % 3`,
          [COUNTS.orders, COUNTS.customers, COUNTS.products],
        );
        await db.raw(
          `INSERT INTO orders (id, order_number, customer_id, status, payment_method, items_total, delivery_fee, agent_fee_share_rate,
           total, ship_governorate_id, ship_governorate_name, ship_recipient_name, ship_recipient_phone, ship_city, ship_area,
           ship_street, ship_building, ship_floor, ship_apartment, ship_landmark, payment_expires_at, placed_at, created_at)
         SELECT id, 'NM-' || lpad(nextval('order_number_seq')::text, 9, '0'), customer_id, 'placed', 'cod', price, ?::numeric,
           0.7000, price + ?::numeric, ?, ?, 'Perf Customer', '+201001234567', 'Cairo', 'Maadi', 'Road 9', '12', NULL, NULL, NULL,
           NULL, now() - n * interval '15 seconds', now() - n * interval '15 seconds'
         FROM po ORDER BY n DESC`,
          [fee, fee, cairo.id, cairo.name],
        );
        await db.raw(
          `INSERT INTO seller_orders (id, order_id, seller_id, status, subtotal, commission_rate, commission, seller_net,
           pickup_governorate_id, pickup_phone, pickup_city, pickup_area, pickup_street, pickup_building, pickup_landmark,
           accept_deadline_at, cancel_reason, cancelled_by_user_id, cancelled_at, created_at)
         SELECT seller_order_id, id, seller_id, 'placed', price, 0.1000, round(price * 0.1, 2), price - round(price * 0.1, 2),
           ?, '+201221234567', 'Cairo', 'Nasr City', 'Street', '5', NULL, now() + interval '30 days', NULL, NULL, NULL,
           now() - n * interval '15 seconds'
         FROM po`,
          [cairo.id],
        );
        await db.raw(
          `INSERT INTO order_items (seller_order_id, variant_id, product_id, product_name, sku, variant_attributes, unit_price,
           quantity, cancelled_quantity, line_total)
         SELECT po.seller_order_id, po.variant_id, po.product_id, pp.name, 'PERF-' || po.product_n || '-' || po.idx,
           jsonb_build_array(jsonb_build_object('attribute', 'Size', 'value', (${sqlArray(SIZES)})[po.idx + 1])),
           po.price, 1, 0, po.price
         FROM po JOIN pp ON pp.n = po.product_n`,
        );
        await db.raw(
          `INSERT INTO payments (order_id, method, status, amount, collected_amount, refunded_amount, provider_order_ref,
           provider_session_url, provider_session_expires_at, provider_transaction_ref, paid_at)
         SELECT id, 'cod', 'pending', price + ?::numeric, 0, 0, NULL, NULL, NULL, NULL, NULL FROM po`,
          [fee],
        );
      });

      await step(`${COUNTS.sellers * COUNTS.ledgerPerSeller} ledger entries`, async () => {
        await db.raw(
          `INSERT INTO finance_accounts (id, account_type, owner_id, balance)
         SELECT uuidv7(), 'seller_payable', ps.id, 90.00 * ? FROM ps`,
          [COUNTS.ledgerPerSeller],
        );
        await db.raw(
          `INSERT INTO ledger_entries (account_id, direction, amount, balance_after, entry_type, reference_type, reference_id,
           source_event_id, created_at)
         SELECT a.id, 'credit', 90.00, 90.00 * e.n, 'seller_net_earned', 'seller_order', uuidv7(), uuidv7(),
           now() - (? - e.n) * interval '1 hour'
         FROM finance_accounts a JOIN ps ON ps.id = a.owner_id AND a.account_type = 'seller_payable'
         CROSS JOIN generate_series(1, ?) e(n)`,
          [COUNTS.ledgerPerSeller, COUNTS.ledgerPerSeller],
        );
      });

      return admin;
    });

    await step('ANALYZE', () => knexDb.raw('ANALYZE'));

    const data = await step('tokens and k6 data', () => writeData(knexDb, admin.id));
    console.log(
      `perf-seed: wrote ${path.relative(process.cwd(), DATA_FILE)} (${data.customers.length} customers, ${data.sellers.length} sellers)`,
    );
  } finally {
    await knexDb.destroy();
  }
  // New categories: the cached tree would hide them.
  const redis = new Redis(requireEnv('REDIS_URL'), {
    keyPrefix: requireEnv('REDIS_KEY_PREFIX'),
    lazyConnect: true,
  });
  await redis.connect();
  await redis.del(CATEGORY_TREE_CACHE_KEY);
  redis.disconnect();
}

/** Access tokens signed like JwtSigner (src/lib/auth/jwt-signer.ts), valid for TOKENS.hours. */
async function writeData(db, adminUserId) {
  const pem = requireEnv('JWT_PRIVATE_KEY').replace(/\\n/g, '\n');
  const key = await importPKCS8(pem, requireEnv('JWT_ALGORITHM'));
  const sign = (sub, role) =>
    new SignJWT({ role })
      .setProtectedHeader({ alg: requireEnv('JWT_ALGORITHM'), kid: requireEnv('JWT_ACTIVE_KID'), typ: 'JWT' })
      .setSubject(sub)
      .setIssuer(requireEnv('JWT_ISSUER'))
      .setAudience(requireEnv('JWT_AUDIENCE'))
      .setIssuedAt()
      .setExpirationTime(`${TOKENS.hours}h`)
      .setJti(randomUUID())
      .sign(key);

  const customers = await db.raw(`SELECT user_id, address_id FROM pc WHERE n <= ? ORDER BY n`, [
    TOKENS.customers,
  ]);
  const sellers = await db.raw(`SELECT user_id FROM ps WHERE n <= ? ORDER BY n`, [TOKENS.sellers]);
  const variants = await db.raw(
    `SELECT id FROM pv WHERE product_n % 20 = 0 ORDER BY product_n, idx LIMIT 5000`,
  );
  const products = await db.raw(
    `SELECT 'perf-product-' || n AS slug FROM pp WHERE n % 50 = 0 ORDER BY n LIMIT 2000`,
  );
  const leafOptions = await db.raw(`SELECT DISTINCT leaf_id FROM perf_leaf_options`);

  const data = {
    generatedAt: new Date().toISOString(),
    admin: await sign(adminUserId, 'admin'),
    customers: await Promise.all(
      customers.rows.map(async (c) => ({
        token: await sign(c.user_id, 'customer'),
        addressId: c.address_id,
      })),
    ),
    sellers: await Promise.all(sellers.rows.map((s) => sign(s.user_id, 'seller'))),
    variantIds: variants.rows.map((v) => v.id),
    productSlugs: products.rows.map((p) => p.slug),
    leafCategoryIds: leafOptions.rows.map((l) => l.leaf_id),
    // Search words with and without typos (spec 06 CA-14).
    searchTerms: VOCABULARY.searchTerms,
  };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
  return data;
}

main().catch((error) => {
  console.error('perf-seed: failed', error);
  process.exit(1);
});
