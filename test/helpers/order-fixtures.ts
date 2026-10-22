import { type Knex } from 'knex';
import { cartFixtures } from './cart-fixtures';

/**
 * SQL-level fixtures for ordering and payment rows (customer → order → seller order → line →
 * reservation / payment), for schema and public-API tests that don't need the checkout flow. Every
 * value is passed explicitly (G13); `overrides` replace single columns.
 */
export function orderFixtures(db: Knex) {
  const cart = cartFixtures(db);

  const one = async (query: Promise<{ id: string }[]>): Promise<string> => {
    const [row] = await query;
    if (!row) throw new Error('insert returned no row');
    return row.id;
  };

  async function governorateId(): Promise<string> {
    const row = await db('governorates')
      .select('id')
      .where({ code: 'EG-C' })
      .first<{ id: string } | undefined>();
    if (!row) throw new Error('governorate EG-C is not seeded');
    return row.id;
  }

  async function nextOrderNumber(): Promise<string> {
    const { rows } = await db.raw<{ rows: { n: string }[] }>(
      `SELECT 'NM-' || lpad(nextval('order_number_seq')::text, 9, '0') AS n`,
    );
    const number = rows[0]?.n;
    if (!number) throw new Error('order_number_seq returned nothing');
    return number;
  }

  /** A COD order of 100.00 + 50.00 fee, `placed`. */
  async function insertOrder(customerId: string, overrides: Record<string, unknown> = {}): Promise<string> {
    return one(
      db('orders')
        .insert({
          order_number: await nextOrderNumber(),
          customer_id: customerId,
          status: 'placed',
          payment_method: 'cod',
          items_total: '100.00',
          delivery_fee: '50.00',
          agent_fee_share_rate: '0.7000',
          total: '150.00',
          coupon_id: null,
          coupon_code: null,
          discount_total: '0.00',
          ship_governorate_id: await governorateId(),
          ship_governorate_name: 'Cairo',
          ship_recipient_name: 'Mona Ali',
          ship_recipient_phone: '+201001234567',
          ship_city: 'Cairo',
          ship_area: 'Maadi',
          ship_street: 'Road 9',
          ship_building: '12',
          ship_floor: null,
          ship_apartment: null,
          ship_landmark: null,
          payment_expires_at: null,
          placed_at: new Date(),
          ...overrides,
        })
        .returning('id'),
    );
  }

  /** A `placed` seller order with a 100.00 subtotal at 10% commission. */
  async function insertSellerOrder(
    orderId: string,
    sellerId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    return one(
      db('seller_orders')
        .insert({
          order_id: orderId,
          seller_id: sellerId,
          status: 'placed',
          subtotal: '100.00',
          commission_rate: '0.1000',
          commission: '10.00',
          seller_net: '90.00',
          discount_amount: '0.00',
          discount_funding: null,
          returned_subtotal: '0.00',
          returned_paid: '0.00',
          returned_commission: '0.00',
          returned_seller_net: '0.00',
          pickup_governorate_id: await governorateId(),
          pickup_phone: '+201221234567',
          pickup_city: 'Cairo',
          pickup_area: 'Nasr City',
          pickup_street: 'Street',
          pickup_building: '5',
          pickup_landmark: null,
          accept_deadline_at: new Date(Date.now() + 86_400_000),
          cancel_reason: null,
          cancelled_by_user_id: null,
          cancelled_at: null,
          ...overrides,
        })
        .returning('id'),
    );
  }

  /** One line of 2 × 50.00. */
  async function insertOrderItem(
    sellerOrderId: string,
    variant: { variantId: string; productId: string },
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    return one(
      db('order_items')
        .insert({
          seller_order_id: sellerOrderId,
          variant_id: variant.variantId,
          product_id: variant.productId,
          product_name: 'Phone',
          sku: 'SKU-1',
          variant_attributes: JSON.stringify([{ attribute: 'Color', value: 'Black' }]),
          unit_price: '50.00',
          quantity: 2,
          cancelled_quantity: 0,
          returned_quantity: 0,
          line_total: '100.00',
          discount_original: '0.00',
          discount_amount: '0.00',
          ...overrides,
        })
        .returning('id'),
    );
  }

  /** customer → COD order → seller order → one line, on a fresh seller and variant. */
  async function insertOrderChain(): Promise<{
    customerId: string;
    customerUserId: string;
    orderId: string;
    sellerOrderId: string;
    orderItemId: string;
    sellerId: string;
    productId: string;
    variantId: string;
  }> {
    const { customerId, userId } = await cart.insertCustomer();
    const { sellerId, productId, variantId } = await cart.insertVariantChain();
    const orderId = await insertOrder(customerId);
    const sellerOrderId = await insertSellerOrder(orderId, sellerId);
    const orderItemId = await insertOrderItem(sellerOrderId, { variantId, productId });
    return {
      customerId,
      customerUserId: userId,
      orderId,
      sellerOrderId,
      orderItemId,
      sellerId,
      productId,
      variantId,
    };
  }

  async function insertInventoryItem(variantId: string, onHand: number, reserved: number): Promise<string> {
    return one(
      db('inventory_items').insert({ variant_id: variantId, on_hand: onHand, reserved }).returning('id'),
    );
  }

  /** A pending COD payment of 150.00. */
  async function insertPayment(orderId: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const order = await db('orders')
      .where({ id: orderId })
      .first<{ customer_id: string } | undefined>('customer_id');
    if (!order) throw new Error(`order ${orderId} not found`);
    return one(
      db('payments')
        .insert({
          order_id: orderId,
          customer_id: order.customer_id,
          method: 'cod',
          status: 'pending',
          amount: '150.00',
          collected_amount: '0.00',
          refunded_amount: '0.00',
          provider_order_ref: null,
          provider_session_url: null,
          provider_session_expires_at: null,
          provider_transaction_ref: null,
          paid_at: null,
          ...overrides,
        })
        .returning('id'),
    );
  }

  return {
    ...cart,
    governorateId,
    nextOrderNumber,
    insertOrder,
    insertSellerOrder,
    insertOrderItem,
    insertOrderChain,
    insertInventoryItem,
    insertPayment,
  };
}
