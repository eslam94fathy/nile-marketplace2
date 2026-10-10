'use strict';
// Usage: npm run seed:dev
// Local development only:
// 1. sample delivery fees, so checkout has deliverable governorates (the migration seeds every fee as
//    NULL on purpose, spec 11 DE-2 / P2-Q4); real fees are set by an admin (PATCH /admin/governorates/:id);
// 2. a sample catalog for the mobile team (P3-Q12 d): a small category tree with attributes and
//    options, and an approved demo seller with a few active products, variants and stock.
// Re-running is safe: fees are set again; the catalog is skipped once the demo seller exists.
// The demo seller's password is random and never printed: use "forgot password" (Mailpit) to log in.
const { randomBytes, createHash } = require('node:crypto');
const bcrypt = require('bcrypt');
const { Decimal } = require('decimal.js');
const knex = require('knex');
const { Redis } = require('ioredis');

/** Sample fees in EGP, keyed by ISO 3166-2:EG code. Every other governorate stays non-deliverable. */
const SAMPLE_FEES = {
  'EG-C': '50.00', // Cairo
  'EG-GZ': '50.00', // Giza
  'EG-KB': '55.00', // Qalyubia
  'EG-ALX': '65.00', // Alexandria
};
// Must match the cache keys in src/app/delivery/constants.ts and src/app/catalog/constants.ts.
const GOVERNORATES_CACHE_KEY = 'v1:delivery:governorates';
const CATEGORY_TREE_CACHE_KEY = 'v1:catalog:category-tree';

const DEMO_SELLER_EMAIL = 'demo-seller@nile.test';

/**
 * Categories with their own attributes (inherited by children, max depth 3). Attribute codes are
 * unique along each root-to-leaf line (spec 06 UC-CA-2).
 */
const TREE = [
  {
    name: 'Electronics',
    slug: 'electronics',
    attributes: [{ name: 'Color', code: 'color', options: ['Black', 'White', 'Blue'] }],
    children: [
      {
        name: 'Phones',
        slug: 'phones',
        attributes: [{ name: 'Storage', code: 'storage', options: ['128 GB', '256 GB'] }],
        children: [],
      },
      { name: 'Audio', slug: 'audio', attributes: [], children: [] },
    ],
  },
  {
    name: 'Fashion',
    slug: 'fashion',
    attributes: [{ name: 'Size', code: 'size', options: ['S', 'M', 'L', 'XL'] }],
    children: [
      {
        name: 'T-Shirts',
        slug: 't-shirts',
        attributes: [{ name: 'Color', code: 'color', options: ['White', 'Black'] }],
        children: [],
      },
    ],
  },
  { name: 'Home', slug: 'home', attributes: [], children: [] },
];

/** Products of the demo seller: options by attribute code → option value; `[]` = default variant. */
const PRODUCTS = [
  {
    category: 'phones',
    name: 'Nile Phone X',
    description: 'A 6.5-inch phone with a two-day battery and a 50 MP camera.',
    variants: [
      { sku: 'NPX-BLK-128', price: '12999.00', stock: 10, options: { color: 'Black', storage: '128 GB' } },
      { sku: 'NPX-BLK-256', price: '14999.00', stock: 4, options: { color: 'Black', storage: '256 GB' } },
      { sku: 'NPX-WHT-128', price: '12999.00', stock: 0, options: { color: 'White', storage: '128 GB' } },
    ],
  },
  {
    category: 'audio',
    name: 'Wireless Earbuds',
    description: 'Noise-cancelling earbuds with a charging case.',
    variants: [
      { sku: 'WEB-BLK', price: '899.00', stock: 25, options: { color: 'Black' } },
      { sku: 'WEB-WHT', price: '949.00', stock: 3, options: { color: 'White' } },
    ],
  },
  {
    category: 't-shirts',
    name: 'Cotton T-Shirt',
    description: 'Egyptian cotton, regular fit.',
    variants: [
      { sku: 'TS-WHT-S', price: '249.00', stock: 12, options: { size: 'S', color: 'White' } },
      { sku: 'TS-WHT-M', price: '249.00', stock: 20, options: { size: 'M', color: 'White' } },
      { sku: 'TS-BLK-L', price: '269.00', stock: 0, options: { size: 'L', color: 'Black' } },
    ],
  },
  {
    category: 'home',
    name: 'Ceramic Vase',
    description: 'Hand-made in Fayoum.',
    variants: [{ sku: 'VASE-01', price: '450.00', stock: 6, options: {} }],
  },
];

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const optionSignature = (ids) =>
  createHash('sha256')
    .update([...ids].sort().join(','))
    .digest('hex');

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    console.error(`dev-seed: ${key} is not set (run with --env-file=.env; see npm run dev:env)`);
    process.exit(1);
  }
  return value;
}

async function seedFees(db) {
  for (const [code, fee] of Object.entries(SAMPLE_FEES)) {
    const updated = await db('governorates')
      .where({ code })
      .update({ delivery_fee: fee, updated_at: db.fn.now() });
    if (updated !== 1) throw new Error(`governorate ${code} not found: run the migrations first`);
  }
  console.log(`dev-seed: delivery fees set for ${Object.keys(SAMPLE_FEES).join(', ')}`);
}

/** Inserts the tree; returns { slug → { id, attributes: { code → { id, options: { value → id } } } } }. */
async function seedTree(trx) {
  const bySlug = {};
  const insert = async (node, parent, depth) => {
    const existing = await trx('categories').where({ slug: node.slug }).first('id');
    const [row] = existing
      ? [existing]
      : await trx('categories')
          .insert({
            parent_id: parent ? parent.id : null,
            name: node.name,
            slug: node.slug,
            depth,
            sort_order: 0,
            is_active: true,
          })
          .returning('id');
    const attributes = { ...(parent ? parent.attributes : {}) };
    for (const [index, attribute] of node.attributes.entries()) {
      let attr = await trx('category_attributes')
        .where({ category_id: row.id, code: attribute.code })
        .first('id');
      if (!attr) {
        [attr] = await trx('category_attributes')
          .insert({ category_id: row.id, name: attribute.name, code: attribute.code, sort_order: index })
          .returning('id');
      }
      const options = {};
      for (const [position, value] of attribute.options.entries()) {
        const code = slugify(value);
        let option = await trx('category_attribute_options')
          .where({ attribute_id: attr.id, code })
          .first('id');
        if (!option) {
          [option] = await trx('category_attribute_options')
            .insert({ attribute_id: attr.id, value, code, sort_order: position })
            .returning('id');
        }
        options[value] = option.id;
      }
      attributes[attribute.code] = { id: attr.id, options };
    }
    bySlug[node.slug] = { id: row.id, attributes };
    for (const child of node.children) await insert(child, bySlug[node.slug], depth + 1);
  };
  for (const root of TREE) await insert(root, null, 1);
  return bySlug;
}

async function seedDemoSeller(trx) {
  const passwordHash = await bcrypt.hash(
    randomBytes(24).toString('base64url'),
    Number(requireEnv('BCRYPT_COST')),
  );
  const [user] = await trx('users')
    .insert({
      email: DEMO_SELLER_EMAIL,
      password_hash: passwordHash,
      role: 'seller',
      status: 'active',
      email_verified_at: trx.fn.now(),
    })
    .returning('id');
  const governorate = await trx('governorates').where({ code: 'EG-C' }).first('id');
  const settings = await trx('seller_settings').first('default_commission_rate');
  const [seller] = await trx('sellers')
    .insert({
      user_id: user.id,
      business_name: 'Nile Demo Shop',
      contact_phone: '+201001234567',
      pickup_governorate_id: governorate.id,
      pickup_city: 'Cairo',
      pickup_area: 'Zamalek',
      pickup_street: '26th of July St',
      pickup_building: '12',
      pickup_landmark: null,
      status: 'approved',
      commission_rate: settings.default_commission_rate,
      rejection_reason: null,
      approved_at: trx.fn.now(),
    })
    .returning('id');
  await trx('seller_status_history').insert([
    {
      seller_id: seller.id,
      from_status: null,
      to_status: 'pending_approval',
      reason: null,
      actor_user_id: null,
    },
    {
      seller_id: seller.id,
      from_status: 'pending_approval',
      to_status: 'approved',
      reason: 'dev seed',
      actor_user_id: null,
    },
  ]);
  return { sellerId: seller.id, userId: user.id };
}

async function seedProducts(trx, tree, { sellerId, userId }) {
  for (const product of PRODUCTS) {
    const category = tree[product.category];
    const active = product.variants;
    // Money as Decimal, never a JS number (CLAUDE.md §6.2).
    const prices = active.map((v) => new Decimal(v.price));
    const [row] = await trx('products')
      .insert({
        seller_id: sellerId,
        category_id: category.id,
        name: product.name,
        slug: `${slugify(product.name)}-${randomBytes(4).toString('hex').slice(0, 6)}`,
        description: product.description,
        status: 'active',
        seller_active: true,
        min_price: Decimal.min(...prices).toFixed(2),
        max_price: Decimal.max(...prices).toFixed(2),
        in_stock: active.some((v) => v.stock > 0),
        published_at: trx.fn.now(),
      })
      .returning('id');
    for (const variant of product.variants) {
      const values = Object.entries(variant.options).map(([code, value]) => {
        const attribute = category.attributes[code];
        const optionId = attribute && attribute.options[value];
        if (!optionId) throw new Error(`${product.name}: no option ${code}=${value} in ${product.category}`);
        return { attribute_id: attribute.id, option_id: optionId };
      });
      if (values.length !== Object.keys(category.attributes).length) {
        throw new Error(
          `${product.name}: ${variant.sku} needs one option per attribute of ${product.category}`,
        );
      }
      const [inserted] = await trx('product_variants')
        .insert({
          product_id: row.id,
          seller_id: sellerId,
          sku: variant.sku,
          price: variant.price,
          compare_at_price: null,
          status: 'active',
          option_signature: optionSignature(values.map((v) => v.option_id)),
          is_default: values.length === 0,
        })
        .returning('id');
      if (values.length > 0) {
        await trx('variant_attribute_values').insert(values.map((v) => ({ variant_id: inserted.id, ...v })));
      }
      const [item] = await trx('inventory_items')
        .insert({ variant_id: inserted.id, on_hand: variant.stock, reserved: 0 })
        .returning('id');
      if (variant.stock > 0) {
        await trx('inventory_movements').insert({
          inventory_item_id: item.id,
          type: 'seller_adjustment',
          quantity_delta: variant.stock,
          on_hand_after: variant.stock,
          reserved_after: 0,
          reference_type: null,
          reference_id: null,
          actor_user_id: userId,
        });
      }
    }
  }
}

async function seedCatalog(db) {
  if (await db('users').where({ email: DEMO_SELLER_EMAIL }).first('id')) {
    console.log('dev-seed: sample catalog already present, skipped');
    return;
  }
  await db.transaction(async (trx) => {
    const tree = await seedTree(trx);
    const seller = await seedDemoSeller(trx);
    await seedProducts(trx, tree, seller);
  });
  console.log(
    `dev-seed: sample catalog created (${PRODUCTS.length} products, demo seller ${DEMO_SELLER_EMAIL}; log in via forgot password)`,
  );
}

async function main() {
  if (requireEnv('NODE_ENV') !== 'development') {
    console.error('dev-seed: refusing to run outside NODE_ENV=development');
    process.exit(1);
  }
  const db = knex({ client: 'pg', connection: requireEnv('DATABASE_URL') });
  const redis = new Redis(requireEnv('REDIS_URL'), {
    keyPrefix: requireEnv('REDIS_KEY_PREFIX'),
    lazyConnect: true,
  });
  try {
    await seedFees(db);
    await seedCatalog(db);
    await redis.connect();
    await redis.del(GOVERNORATES_CACHE_KEY, CATEGORY_TREE_CACHE_KEY);
  } finally {
    await db.destroy();
    redis.disconnect();
  }
}

main().catch((error) => {
  console.error('dev-seed failed:', error.message);
  process.exit(1);
});
