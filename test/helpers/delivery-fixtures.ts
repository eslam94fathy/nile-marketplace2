import { type Knex } from 'knex';
import { orderFixtures } from './order-fixtures';

/**
 * SQL-level fixtures for delivery rows (agent → shipment of a seller order), for schema and service
 * tests that don't need the HTTP or event flow. Every value is passed explicitly (G13).
 */
export function deliveryFixtures(db: Knex) {
  const orders = orderFixtures(db);

  const one = async (query: Promise<{ id: string }[]>): Promise<string> => {
    const [row] = await query;
    if (!row) throw new Error('insert returned no row');
    return row.id;
  };

  /** An active agent in Cairo, off shift unless overridden. */
  async function insertAgent(
    overrides: Record<string, unknown> = {},
  ): Promise<{ agentId: string; userId: string }> {
    const userId = await orders.insertUser('delivery_agent');
    const agentId = await one(
      db('delivery_agents')
        .insert({
          user_id: userId,
          full_name: 'Karim Hassan',
          phone: '+201101234567',
          home_governorate_id: await orders.governorateId(),
          status: 'active',
          on_shift: false,
          last_assigned_at: null,
          ...overrides,
        })
        .returning('id'),
    );
    return { agentId, userId };
  }

  /** An unassigned COD shipment for a seller order (50.00 checkout fee, 100.00 to collect for the items). */
  async function insertShipment(
    ids: { sellerOrderId: string; orderId: string },
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const governorateId = await orders.governorateId();
    return one(
      db('shipments')
        .insert({
          seller_order_id: ids.sellerOrderId,
          order_id: ids.orderId,
          agent_id: null,
          status: 'unassigned',
          order_number: 'NM-000000001',
          payment_method: 'cod',
          order_delivery_fee: '50.00',
          pickup_business_name: 'Nile Crafts',
          pickup_governorate_id: governorateId,
          pickup_phone: '+201221234567',
          pickup_city: 'Cairo',
          pickup_area: 'Nasr City',
          pickup_street: 'Street',
          pickup_building: '5',
          pickup_landmark: null,
          dropoff_recipient_name: 'Mona Ali',
          dropoff_recipient_phone: '+201001234567',
          dropoff_governorate_id: governorateId,
          dropoff_governorate_name: 'Cairo',
          dropoff_city: 'Cairo',
          dropoff_area: 'Maadi',
          dropoff_street: 'Road 9',
          dropoff_building: '12',
          dropoff_floor: null,
          dropoff_apartment: null,
          dropoff_landmark: null,
          cod_items_amount: '100.00',
          carries_delivery_fee: false,
          cod_fee_amount: '0.00',
          cod_collected_amount: null,
          attempt_count: 0,
          assigned_at: null,
          picked_up_at: null,
          delivered_at: null,
          returned_at: null,
          seller_order_cancelled_at: null,
          ...overrides,
        })
        .returning('id'),
    );
  }

  /** A placed COD order with one seller order, and its unassigned shipment. */
  async function insertShipmentChain(overrides: Record<string, unknown> = {}) {
    const chain = await orders.insertOrderChain();
    const shipmentId = await insertShipment(
      { sellerOrderId: chain.sellerOrderId, orderId: chain.orderId },
      overrides,
    );
    return { ...chain, shipmentId };
  }

  return { ...orders, insertAgent, insertShipment, insertShipmentChain };
}
