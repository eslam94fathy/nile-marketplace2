import { expect } from 'vitest';
import { type AgentShipmentDto } from '../../src/app/delivery/dto/shipment.dto';
import { type CheckoutResultDto } from '../../src/app/ordering/dto/order-response.dto';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import { closeInfrastructure, createWorkerInfrastructure } from '../../src/infrastructure';
import { EventConsumerHost, OutboxDrainer } from '../../src/lib/events';
import { waitFor } from './amqp-probe';
import { deliveryFixtures } from './delivery-fixtures';
import { errorBody, successBody } from './http';
import { signTestAccessToken } from './jwt';
import { createMemoryLogger } from './memory-logger';
import { CAIRO_FEE, orderingApi } from './ordering-api';
import { startTestApp } from './test-app';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/**
 * The api plus a worker running every consumer, for delivery flows end to end: checkout → seller
 * ready → shipment → agent → ordering / payments. `settle` publishes the outbox until a check holds.
 */
export async function startDeliveryFlow() {
  const t = await startTestApp();
  const api = orderingApi(t);
  await api.init();
  const knex = () => t.infra.db.knex;
  const fx = deliveryFixtures(knex());
  const { logger, writer: workerLogs } = createMemoryLogger();
  const worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
  const workerContainer = createWorkerContainer(worker);
  await worker.broker.assertExchange(worker.env.RABBITMQ_EXCHANGE);
  const consumers = new EventConsumerHost(worker.broker, worker.db, logger, worker.env);
  for (const handler of createEventHandlers(workerContainer)) await consumers.start(handler);
  const drainer = new OutboxDrainer(worker.db.knex, worker.broker, worker.clock, logger, {
    exchange: worker.env.RABBITMQ_EXCHANGE,
    batchSize: worker.env.OUTBOX_BATCH_SIZE,
    maxBackoffMs: worker.env.OUTBOX_MAX_BACKOFF_MS,
  });

  /** Publishes the outbox until `check` holds: every consumer in the chain gets its turn. */
  const settle = (check: () => Promise<boolean>) =>
    waitFor(async () => {
      await drainer.drainOnce();
      return check();
    }, 20_000);

  const sellerOrderStatus = async (id: string) =>
    (await knex()('seller_orders').where({ id }).first<{ status: string }>('status'))?.status;

  type AgentClient = { http: ReturnType<typeof api.as> };

  /** An on-shift Cairo agent with its token; every other agent goes off shift first. */
  async function soleAgent() {
    await knex()('delivery_agents').update({ on_shift: false });
    const agent = await fx.insertAgent({ on_shift: true });
    const token = await signTestAccessToken({ sub: agent.userId, role: 'delivery_agent' });
    return { ...agent, token, http: api.as(token) };
  }

  /** One COD order with one Cairo seller per line (one unit unless `quantity` is given). */
  async function order(lines: (string | { price: string; quantity: number })[]) {
    const buyer = await api.customer();
    const parsed = lines.map((l) => (typeof l === 'string' ? { price: l, quantity: 1 } : l));
    const variants = [];
    for (const line of parsed) variants.push(await api.listedVariant({ price: line.price }));
    const itemsTotal = parsed.reduce((sum, l) => sum + Number(l.price) * l.quantity, 0);
    const result: CheckoutResultDto = await api.placeOrder(
      buyer,
      variants.map((v, i) => ({ variantId: v.variantId, quantity: must(parsed[i]).quantity })),
      (itemsTotal + Number(CAIRO_FEE)).toFixed(2),
    );
    return {
      orderId: result.order.id,
      sellerOrders: variants.map((v) => ({
        ...v,
        sellerOrderId: must(result.order.sellerOrders.find((s) => s.sellerId === v.sellerId)).id,
      })),
    };
  }

  /** The seller accepts and marks ready over HTTP; nothing is published yet. */
  async function markReady(entry: { sellerToken: string; sellerOrderId: string }) {
    const seller = api.as(entry.sellerToken);
    expect((await seller.post(`/seller/orders/${entry.sellerOrderId}/accept`)).status).toBe(200);
    expect((await seller.post(`/seller/orders/${entry.sellerOrderId}/ready`)).status).toBe(200);
  }

  /** Ready, then the consumer creates the shipment and auto-assigns it to `agent`. */
  async function readyAndAssigned(
    entry: { sellerToken: string; sellerOrderId: string },
    agent: { agentId: string },
  ) {
    await markReady(entry);
    let shipmentId = '';
    await settle(async () => {
      const row = await knex()('shipments')
        .where({ seller_order_id: entry.sellerOrderId })
        .first<{ id: string; agent_id: string | null } | undefined>('id', 'agent_id');
      shipmentId = row?.id ?? '';
      return row?.agent_id === agent.agentId;
    });
    return shipmentId;
  }

  const act = async (agent: AgentClient, shipmentId: string, action: string, body?: object) => {
    const res = await agent.http.post(`/agent/shipments/${shipmentId}/${action}`, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return successBody<AgentShipmentDto>(res).data;
  };

  const refused = (res: { status: number; body: unknown }, status: number, code: string) => {
    expect([res.status, errorBody(res as never).error.code]).toEqual([status, code]);
  };

  async function close() {
    await closeInfrastructure(worker);
    await t.close();
  }

  return {
    t,
    api,
    fx,
    knex,
    worker,
    workerContainer,
    workerLogs,
    drainer,
    settle,
    sellerOrderStatus,
    soleAgent,
    order,
    markReady,
    readyAndAssigned,
    act,
    refused,
    close,
  };
}

export type DeliveryFlow = Awaited<ReturnType<typeof startDeliveryFlow>>;
export type Agent = Awaited<ReturnType<DeliveryFlow['soleAgent']>>;
