import { createHash, randomUUID } from 'node:crypto';
import { type Knex } from 'knex';

/**
 * SQL-level fixtures for catalog rows (sellers → categories → products → variants), for tests that
 * need the tables but not the catalog HTTP flow (schema tests, inventory). Every value is passed
 * explicitly: business columns have no DB defaults (G13).
 */

export const signatureOf = (optionIds: readonly string[]): string =>
  createHash('sha256')
    .update([...optionIds].sort().join(','))
    .digest('hex');

const one = async (query: Promise<{ id: string }[]>): Promise<string> => {
  const [row] = await query;
  if (!row) throw new Error('insert returned no row');
  return row.id;
};

export function catalogFixtures(db: Knex) {
  async function insertUser(role = 'seller'): Promise<string> {
    return one(
      db('users')
        .insert({
          email: `${randomUUID()}@example.com`,
          password_hash: '$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234',
          role,
          status: 'active',
        })
        .returning('id'),
    );
  }

  async function insertSeller(status = 'approved'): Promise<{ sellerId: string; userId: string }> {
    const userId = await insertUser('seller');
    const governorate = await db('governorates').select('id').where({ code: 'EG-C' }).first<{ id: string }>();
    const sellerId = await one(
      db('sellers')
        .insert({
          user_id: userId,
          business_name: `Shop ${randomUUID()}`,
          contact_phone: '+201221234567',
          pickup_governorate_id: governorate?.id,
          pickup_city: 'Cairo',
          pickup_area: 'Nasr City',
          pickup_street: 'Street',
          pickup_building: '5',
          status,
          commission_rate: '0.1000',
          approved_at: status === 'approved' ? new Date() : null,
        })
        .returning('id'),
    );
    return { sellerId, userId };
  }

  async function insertCategory(
    overrides: { parentId?: string | null; depth?: number; name?: string; slug?: string } = {},
  ): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    return one(
      db('categories')
        .insert({
          parent_id: overrides.parentId ?? null,
          name: overrides.name ?? `Category ${suffix}`,
          slug: overrides.slug ?? `category-${suffix}`,
          depth: overrides.depth ?? 1,
          sort_order: 0,
          is_active: true,
        })
        .returning('id'),
    );
  }

  async function insertProduct(
    sellerId: string,
    categoryId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    return one(
      db('products')
        .insert({
          seller_id: sellerId,
          category_id: categoryId,
          name: 'Phone',
          slug: `phone-${randomUUID().slice(0, 8)}`,
          description: 'A phone',
          status: 'draft',
          seller_active: true,
          min_price: null,
          max_price: null,
          in_stock: false,
          ...overrides,
        })
        .returning('id'),
    );
  }

  async function insertVariant(
    productId: string,
    sellerId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    return one(
      db('product_variants')
        .insert({
          product_id: productId,
          seller_id: sellerId,
          sku: `SKU-${randomUUID().slice(0, 8)}`,
          price: '100.00',
          compare_at_price: null,
          status: 'active',
          option_signature: signatureOf([randomUUID()]),
          is_default: false,
          ...overrides,
        })
        .returning('id'),
    );
  }

  /** seller → root category → draft product → one active variant (no stock row). */
  async function insertVariantChain(): Promise<{
    sellerId: string;
    sellerUserId: string;
    categoryId: string;
    productId: string;
    variantId: string;
  }> {
    const { sellerId, userId } = await insertSeller();
    const categoryId = await insertCategory();
    const productId = await insertProduct(sellerId, categoryId);
    const variantId = await insertVariant(productId, sellerId);
    return { sellerId, sellerUserId: userId, categoryId, productId, variantId };
  }

  return { insertUser, insertSeller, insertCategory, insertProduct, insertVariant, insertVariantChain };
}
