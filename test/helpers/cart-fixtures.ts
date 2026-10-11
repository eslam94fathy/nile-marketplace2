import { type Knex } from 'knex';
import { catalogFixtures } from './catalog-fixtures';

/**
 * SQL-level fixtures for cart rows (customer → cart → lines), for schema and public-API tests that
 * don't need the cart HTTP flow. Every value is passed explicitly (G13).
 */
export function cartFixtures(db: Knex) {
  const catalog = catalogFixtures(db);

  const one = async (query: Promise<{ id: string }[]>): Promise<string> => {
    const [row] = await query;
    if (!row) throw new Error('insert returned no row');
    return row.id;
  };

  async function insertCustomer(): Promise<{ customerId: string; userId: string }> {
    const userId = await catalog.insertUser('customer');
    const customerId = await one(
      db('customers')
        .insert({ user_id: userId, first_name: 'Mona', last_name: 'Ali', phone: '+201001234567' })
        .returning('id'),
    );
    return { customerId, userId };
  }

  async function insertCart(customerId: string): Promise<string> {
    return one(db('carts').insert({ customer_id: customerId }).returning('id'));
  }

  async function insertCartItem(cartId: string, variantId: string, quantity: number): Promise<string> {
    return one(db('cart_items').insert({ cart_id: cartId, variant_id: variantId, quantity }).returning('id'));
  }

  return { ...catalog, insertCustomer, insertCart, insertCartItem };
}
