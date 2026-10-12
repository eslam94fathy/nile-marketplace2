import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect } from 'vitest';
import { type CheckoutResultDto } from '../../src/app/ordering/dto/order-response.dto';
import { successBody } from './http';
import { API } from './identity';
import { signTestAccessToken } from './jwt';
import { orderFixtures } from './order-fixtures';
import { type TestApp } from './test-app';

/** Delivery fee the helpers set on Cairo (before anything reads, and caches, the governorates). */
export const CAIRO_FEE = '50.00';

/**
 * HTTP-level setup for ordering tests: customers with an address, listed variants with stock, carts,
 * and COD checkouts through the real endpoint. Call `init()` in `beforeAll`, before any request.
 */
export function orderingApi(t: TestApp) {
  const knex = () => t.infra.db.knex;
  const fx = orderFixtures(knex());
  let cairoId = '';

  const as = (token: string | undefined) => {
    const auth = (req: request.Test) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
    const withKey = (req: request.Test, key: string | null) => (key ? req.set('Idempotency-Key', key) : req);
    return {
      get: (path: string) => auth(request(t.app).get(`${API}${path}`)),
      post: (path: string, body?: object, key: string | null = randomUUID()) =>
        withKey(auth(request(t.app).post(`${API}${path}`)), key).send(body),
      checkout: (body: object, key: string | null = randomUUID()) =>
        withKey(auth(request(t.app).post(`${API}/checkout`)), key).send(body),
    };
  };

  async function init(): Promise<void> {
    cairoId = await fx.governorateId();
    await knex()('governorates').where({ id: cairoId }).update({ delivery_fee: CAIRO_FEE });
  }

  /** A customer with an address in `governorateId` (Cairo by default) and a token. */
  async function customer(governorateId?: string) {
    const { customerId, userId } = await fx.insertCustomer();
    const [address] = await knex()('customer_addresses')
      .insert({
        customer_id: customerId,
        governorate_id: governorateId ?? cairoId,
        label: 'Home',
        recipient_name: 'Mona Ali',
        recipient_phone: '+201001234567',
        city: 'Cairo',
        area: 'Maadi',
        street: 'Road 9',
        building: '12',
        floor: '3',
        apartment: null,
        landmark: null,
        is_default: true,
      })
      .returning<{ id: string }[]>('id');
    if (!address) throw new Error('fixture');
    return {
      customerId,
      userId,
      addressId: address.id,
      token: await signTestAccessToken({ sub: userId, role: 'customer' }),
    };
  }

  /** An active, visible variant with stock, of a fresh approved seller unless one is given. */
  async function listedVariant(options: { price?: string; onHand?: number; sellerId?: string } = {}) {
    const price = options.price ?? '100.00';
    const seller = options.sellerId ? { sellerId: options.sellerId, userId: '' } : await fx.insertSeller();
    const categoryId = await fx.insertCategory();
    const productId = await fx.insertProduct(seller.sellerId, categoryId, {
      status: 'active',
      published_at: new Date(),
      min_price: price,
      max_price: price,
      in_stock: true,
    });
    const variantId = await fx.insertVariant(productId, seller.sellerId, { price });
    await fx.insertInventoryItem(variantId, options.onHand ?? 10, 0);
    return {
      variantId,
      productId,
      sellerId: seller.sellerId,
      sellerUserId: seller.userId,
      sellerToken: seller.userId ? await signTestAccessToken({ sub: seller.userId, role: 'seller' }) : '',
    };
  }

  async function fillCart(customerId: string, lines: { variantId: string; quantity: number }[]) {
    const cartId =
      (await knex()('carts').where({ customer_id: customerId }).first<{ id: string } | undefined>('id'))
        ?.id ?? (await fx.insertCart(customerId));
    for (const line of lines) await fx.insertCartItem(cartId, line.variantId, line.quantity);
  }

  /** Fills the cart and checks out with COD; `expectedTotal` must match. */
  async function placeOrder(
    buyer: { customerId: string; addressId: string; token: string },
    lines: { variantId: string; quantity: number }[],
    expectedTotal: string,
  ): Promise<CheckoutResultDto> {
    await fillCart(buyer.customerId, lines);
    const res = await as(buyer.token).checkout({
      addressId: buyer.addressId,
      paymentMethod: 'cod',
      expectedTotal,
    });
    expect(res.status).toBe(201);
    return successBody<CheckoutResultDto>(res).data;
  }

  const stockOf = (variantId: string) =>
    knex()('inventory_items')
      .where({ variant_id: variantId })
      .first<{ on_hand: number; reserved: number }>('on_hand', 'reserved');

  /** Payloads of one outbox event type for an aggregate, oldest first. */
  const eventsOf = async (eventType: string, aggregateId: string) =>
    (
      await knex()('events_outbox')
        .where({ event_type: eventType, aggregate_id: aggregateId })
        .orderBy('id')
        .select<{ payload: Record<string, unknown> }[]>('payload')
    ).map((row) => row.payload);

  return {
    fx,
    as,
    init,
    cairoId: () => cairoId,
    customer,
    listedVariant,
    fillCart,
    placeOrder,
    stockOf,
    eventsOf,
  };
}
