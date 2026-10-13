import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type DependencyContainer } from 'tsyringe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SELLER_ORDER_UPDATES_QUEUE } from '../../src/app/delivery/constants';
import { type AdminShipmentDto } from '../../src/app/delivery/dto/shipment.dto';
import { type AssignmentRetryJob } from '../../src/app/delivery/service/assignment-retry.job';
import { type ShipmentAssignmentService } from '../../src/app/delivery/service/shipment-assignment.service';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { TOKENS } from '../../src/lib/di';
import { EventConsumerHost, OutboxDrainer } from '../../src/lib/events';
import { AmqpProbe, waitFor } from '../helpers/amqp-probe';
import { deliveryFixtures } from '../helpers/delivery-fixtures';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { createMemoryLogger } from '../helpers/memory-logger';
import { CAIRO_FEE, orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_V7_ID = '0192f5e0-0000-7000-8000-000000000000';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/* Spec 11 UC-DE-1 (creation + auto-assignment), the retry job (DE-9) and UC-DE-4 (admin assignment). */
describe('delivery: shipments and assignment', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let fx: ReturnType<typeof deliveryFixtures>;
  let worker: WorkerInfrastructure;
  let workerContainer: DependencyContainer;
  let drainer: OutboxDrainer;
  let probe: AmqpProbe;
  let adminToken: string;
  let cairoId: string;
  let gizaId: string;

  const knex = () => t.infra.db.knex;
  const shipmentOf = (sellerOrderId: string) =>
    knex()('shipments')
      .where({ seller_order_id: sellerOrderId })
      .first<{ id: string; status: string; agent_id: string | null } | undefined>('id', 'status', 'agent_id');
  const assignment = () =>
    workerContainer.resolve<ShipmentAssignmentService>(TOKENS.ShipmentAssignmentService);
  const retryJob = () => workerContainer.resolve<AssignmentRetryJob>(TOKENS.AssignmentRetryJob);
  const admin = () => ({
    get: (path: string) => request(t.app).get(`${API}${path}`).set('Authorization', `Bearer ${adminToken}`),
    assign: (shipmentId: string, agentId: string, token = adminToken) =>
      request(t.app)
        .post(`${API}/admin/shipments/${shipmentId}/assign`)
        .set('Authorization', `Bearer ${token}`)
        .send({ agentId }),
  });

  /** A placed COD order of one Cairo seller, accepted and marked ready over HTTP. */
  async function readyOrder() {
    const buyer = await api.customer();
    const variant = await api.listedVariant({ price: '100.00' });
    const result = await api.placeOrder(buyer, [{ variantId: variant.variantId, quantity: 1 }], '150.00');
    const sellerOrder = must(result.order.sellerOrders[0]);
    const seller = api.as(variant.sellerToken);
    expect((await seller.post(`/seller/orders/${sellerOrder.id}/accept`)).status).toBe(200);
    expect((await seller.post(`/seller/orders/${sellerOrder.id}/ready`)).status).toBe(200);
    return { result, sellerOrderId: sellerOrder.id, variant };
  }

  /** Publishes the outbox and waits for the delivery consumer to create the shipment. */
  async function shipmentFor(sellerOrderId: string) {
    await drainer.drainOnce();
    await waitFor(async () => (await shipmentOf(sellerOrderId)) !== undefined);
    return must(await shipmentOf(sellerOrderId));
  }

  /** An unassigned shipment of a fresh order, picked up in `governorateId`. */
  async function unassignedShipment(governorateId = cairoId) {
    const { shipmentId } = await fx.insertShipmentChain({ pickup_governorate_id: governorateId });
    return shipmentId;
  }

  const onShift = (overrides: Record<string, unknown> = {}) =>
    fx.insertAgent({ on_shift: true, ...overrides });
  const assignNow = (shipmentId: string) => assignment().retry(shipmentId);

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
    fx = deliveryFixtures(knex());
    cairoId = api.cairoId();
    gizaId = (await knex()('governorates').where({ code: 'EG-GZ' }).first<{ id: string }>('id')).id;
    adminToken = await signTestAccessToken({ sub: await fx.insertUser('admin'), role: 'admin' });
    const { logger } = createMemoryLogger();
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
    workerContainer = createWorkerContainer(worker);
    await worker.broker.assertExchange(worker.env.RABBITMQ_EXCHANGE);
    const consumers = new EventConsumerHost(worker.broker, worker.db, logger, worker.env);
    for (const handler of createEventHandlers(workerContainer)) await consumers.start(handler);
    drainer = new OutboxDrainer(worker.db.knex, worker.broker, worker.clock, logger, {
      exchange: worker.env.RABBITMQ_EXCHANGE,
      batchSize: worker.env.OUTBOX_BATCH_SIZE,
      maxBackoffMs: worker.env.OUTBOX_MAX_BACKOFF_MS,
    });
    probe = await AmqpProbe.open(t.resources.workerEnv.RABBITMQ_URL);
  });
  afterAll(async () => {
    await probe.close();
    await closeInfrastructure(worker);
    await t.close();
  });

  it('seller_order.ready_for_pickup creates the shipment from its snapshot; a replay creates nothing', async () => {
    // No Cairo agent is on shift for this one (every agent here is created off shift or elsewhere).
    await knex()('delivery_agents').update({ on_shift: false });
    const { result, sellerOrderId } = await readyOrder();
    const created = await shipmentFor(sellerOrderId);
    expect(created).toMatchObject({ status: 'unassigned', agent_id: null });

    const detail = successBody<AdminShipmentDto>(await admin().get(`/admin/shipments/${created.id}`)).data;
    expect(detail).toMatchObject({
      sellerOrderId,
      orderId: result.order.id,
      orderNumber: result.order.orderNumber,
      paymentMethod: 'cod',
      codItemsAmount: '100.00',
      codFeeAmount: '0.00',
      amountToCollect: '100.00',
      carriesDeliveryFee: false,
      attemptCount: 0,
      dropoff: { recipientName: 'Mona Ali', governorateName: 'Cairo', floor: '3' },
    });
    expect(detail.pickup.businessName).toMatch(/^Shop /);
    expect(detail.history?.map((h) => [h.fromStatus, h.toStatus, h.actorRole])).toEqual([
      [null, 'unassigned', 'system'],
    ]);
    const fee = await knex()('shipments')
      .where({ id: created.id })
      .first<{ order_delivery_fee: string }>('order_delivery_fee');
    expect(fee.order_delivery_fee).toBe(CAIRO_FEE);

    // The same event again (a new eventId, so not deduplicated by the consumer host).
    const [ready] = await knex()('events_outbox')
      .where({ event_type: 'seller_order.ready_for_pickup', aggregate_id: sellerOrderId })
      .select<{ payload: object }[]>('payload');
    const replayId = randomUUID();
    probe.channel.publish(
      worker.env.RABBITMQ_EXCHANGE,
      'seller_order.ready_for_pickup',
      Buffer.from(
        JSON.stringify({
          eventId: replayId,
          eventType: 'seller_order.ready_for_pickup',
          version: 1,
          occurredAt: new Date().toISOString(),
          correlationId: null,
          aggregateType: 'seller_order',
          aggregateId: sellerOrderId,
          payload: must(ready).payload,
        }),
      ),
      { persistent: true },
    );
    await waitFor(
      async () =>
        (await knex()('processed_events').where({ consumer: SELLER_ORDER_UPDATES_QUEUE, event_id: replayId }))
          .length === 1,
    );
    expect(await knex()('shipments').where({ seller_order_id: sellerOrderId })).toHaveLength(1);
  });

  it('auto-assigns to the on-shift agent of the pickup governorate with the fewest active shipments', async () => {
    await knex()('delivery_agents').update({ on_shift: false });
    const busy = await onShift({ last_assigned_at: new Date(Date.now() - 3_600_000) });
    const idle = await onShift({ last_assigned_at: new Date() });
    await onShift({ home_governorate_id: gizaId }); // other governorate
    await fx.insertAgent({ on_shift: false }); // off shift
    await fx.insertAgent({ status: 'inactive', on_shift: false });
    const loaded = await unassignedShipment();
    await knex()('shipments')
      .where({ id: loaded })
      .update({ status: 'assigned', agent_id: busy.agentId, assigned_at: new Date() });

    // `busy` was idle longer, but has one active shipment: `idle` wins.
    const shipmentId = await unassignedShipment();
    expect(await assignNow(shipmentId)).toBe(true);
    expect(
      (await knex()('shipments').where({ id: shipmentId }).first<{ agent_id: string }>('agent_id')).agent_id,
    ).toBe(idle.agentId);

    // Now both have one: the one idle longest (busy) wins the tie.
    const next = await unassignedShipment();
    await assignNow(next);
    expect(
      (await knex()('shipments').where({ id: next }).first<{ agent_id: string }>('agent_id')).agent_id,
    ).toBe(busy.agentId);

    const [event] = await knex()('events_outbox')
      .where({ event_type: 'shipment.assigned', aggregate_id: next })
      .select<{ payload: Record<string, unknown> }[]>('payload');
    expect(event?.payload).toMatchObject({
      agentId: busy.agentId,
      previousAgentId: null,
      assignedBy: 'auto',
    });
    const agent = await knex()('delivery_agents')
      .where({ id: busy.agentId })
      .first<{ last_assigned_at: Date }>('last_assigned_at');
    expect(Date.now() - agent.last_assigned_at.getTime()).toBeLessThan(60_000);
  });

  it('with no candidate the shipment waits; the retry job assigns it once an agent goes on shift', async () => {
    await knex()('delivery_agents').update({ on_shift: false });
    const shipmentId = await unassignedShipment(gizaId);
    expect(await retryJob().run(100)).toBe(0);
    expect(
      (await knex()('shipments').where({ id: shipmentId }).first<{ status: string }>('status')).status,
    ).toBe('unassigned');

    const agent = await onShift({ home_governorate_id: gizaId });
    expect(await retryJob().run(100)).toBeGreaterThanOrEqual(1);
    expect(await knex()('shipments').where({ id: shipmentId }).first('status', 'agent_id')).toEqual({
      status: 'assigned',
      agent_id: agent.agentId,
    });
  });

  it('parallel assignments never fail and leave nothing unassigned while agents are free', async () => {
    await knex()('delivery_agents').update({ on_shift: false });
    const agents = [await onShift(), await onShift(), await onShift()];
    const shipments = await Promise.all(Array.from({ length: 6 }, () => unassignedShipment()));
    const results = await Promise.all(shipments.map((id) => assignment().retry(id)));
    // A transaction that found every candidate locked by the others leaves its shipment for the next run.
    const left = shipments.filter((_, i) => !results[i]);
    for (const id of left) await assignment().retry(id);
    const rows = await knex()('shipments')
      .whereIn('id', shipments)
      .select<{ status: string; agent_id: string }[]>('status', 'agent_id');
    expect(rows.every((r) => r.status === 'assigned')).toBe(true);
    const counts = agents.map((a) => rows.filter((r) => r.agent_id === a.agentId).length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(6);
    expect(Math.max(...counts)).toBeLessThanOrEqual(4);
  });

  describe('admin', () => {
    it('assigns, reassigns, and refuses the same agent, inactive or unknown agents and picked-up parcels', async () => {
      const shipmentId = await unassignedShipment();
      const first = await fx.insertAgent();
      const second = await fx.insertAgent();
      const assigned = await admin().assign(shipmentId, first.agentId);
      expect(assigned.status).toBe(200);
      expect(successBody<AdminShipmentDto>(assigned).data).toMatchObject({
        status: 'assigned',
        agentId: first.agentId,
      });

      const same = await admin().assign(shipmentId, first.agentId);
      expect([same.status, errorBody(same).error.code]).toEqual([409, 'SHIPMENT_ALREADY_ASSIGNED_TO_AGENT']);
      const reassigned = successBody<AdminShipmentDto>(await admin().assign(shipmentId, second.agentId)).data;
      expect(reassigned.agentId).toBe(second.agentId);
      expect(reassigned.history?.at(-1)).toMatchObject({
        fromStatus: 'assigned',
        toStatus: 'assigned',
        actorRole: 'admin',
        reason: 'reassigned',
      });
      const [, reassignEvent] = await knex()('events_outbox')
        .where({ event_type: 'shipment.assigned', aggregate_id: shipmentId })
        .orderBy('id')
        .select<{ payload: Record<string, unknown> }[]>('payload');
      expect(reassignEvent?.payload).toMatchObject({
        agentId: second.agentId,
        previousAgentId: first.agentId,
        assignedBy: 'admin',
      });

      const inactive = await fx.insertAgent({ status: 'inactive' });
      const refused = await admin().assign(shipmentId, inactive.agentId);
      expect([refused.status, errorBody(refused).error.code]).toEqual([409, 'AGENT_INACTIVE']);
      const unknown = await admin().assign(shipmentId, UNKNOWN_V7_ID);
      expect([unknown.status, errorBody(unknown).error.code]).toEqual([422, 'AGENT_NOT_FOUND']);
      await knex()('shipments').where({ id: shipmentId }).update({ status: 'picked_up' });
      const late = await admin().assign(shipmentId, first.agentId);
      expect([late.status, errorBody(late).error.code]).toEqual([409, 'SHIPMENT_NOT_ASSIGNABLE']);
      expect((await admin().assign(UNKNOWN_V7_ID, first.agentId)).status).toBe(404);
      expect(
        (
          await request(t.app)
            .post(`${API}/admin/shipments/${shipmentId}/assign`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({})
        ).status,
      ).toBe(400);
    });

    it('lists shipments with filters and pages; other roles are refused', async () => {
      const agent = await fx.insertAgent();
      const mine = await unassignedShipment();
      await admin().assign(mine, agent.agentId);
      const byAgent = successBody<AdminShipmentDto[]>(
        await admin().get(`/admin/shipments?agentId[eq]=${agent.agentId}`),
      ).data;
      expect(byAgent.map((s) => s.id)).toEqual([mine]);
      expect(byAgent[0]?.history).toBeUndefined();
      const assigned = successBody<AdminShipmentDto[]>(
        await admin().get('/admin/shipments?status[in]=assigned&limit=100'),
      ).data;
      expect(assigned.every((s) => s.status === 'assigned')).toBe(true);
      expect((await admin().get('/admin/shipments?status[eq]=lost')).status).toBe(400);

      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: AdminShipmentDto[]; meta?: { nextCursor?: string | null } } = successBody<
          AdminShipmentDto[]
        >(await admin().get(`/admin/shipments?limit=3${cursor ? `&cursor=${cursor}` : ''}`));
        ids.push(...page.data.map((s) => s.id));
        cursor = page.meta?.nextCursor ?? null;
      } while (cursor);
      const total = Number((await knex()('shipments').count<{ count: string }[]>('*'))[0]?.count);
      expect(new Set(ids).size).toBe(total);

      const agentToken = await signTestAccessToken({ sub: agent.userId, role: 'delivery_agent' });
      expect(
        (await request(t.app).get(`${API}/admin/shipments`).set('Authorization', `Bearer ${agentToken}`))
          .status,
      ).toBe(403);
    });
  });
});
