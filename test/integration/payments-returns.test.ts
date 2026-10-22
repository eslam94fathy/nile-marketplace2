import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IPaymentDirectory } from '../../src/app/payments';
import { ORDER_ADJUSTMENTS_QUEUE } from '../../src/app/payments/constants';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { TOKENS } from '../../src/lib/di';
import { EventConsumerHost, refundPayoutAad } from '../../src/lib/events';
import { type ISecretBox } from '../../src/pkg/crypto';
import { deadLetterQueueName } from '../../src/pkg/messaging';
import { AmqpProbe, waitFor } from '../helpers/amqp-probe';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { createMemoryLogger } from '../helpers/memory-logger';
import { orderFixtures } from '../helpers/order-fixtures';
import { startTestApp, type TestApp } from '../helpers/test-app';

interface RefundBody {
  id: string;
  returnId: string | null;
  reason: string;
  status: string;
  method: string;
  amount: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  hasPayoutDetails: boolean;
  payoutDetails?: { method: string; walletNumber?: string } | null;
}

/*
 * Spec 10 §8 (UC-PA-5, §8.4, §8.5) on real Postgres + RabbitMQ: `return.completed` (published here, as
 * returns does) → a refund due, the admin refund detail with the opened COD payout details, recording a
 * COD refund, handing a Kashier refund to the job, and the return views' refund status.
 */
describe('payments: return refunds', () => {
  let t: TestApp;
  let worker: WorkerInfrastructure;
  let probe: AmqpProbe;
  let fx: ReturnType<typeof orderFixtures>;
  let admin: string;
  let box: ISecretBox;
  const knex = () => t.infra.db.knex;
  const asAdmin = {
    get: (path: string) => request(t.app).get(`${API}${path}`).set('Authorization', `Bearer ${admin}`),
    post: (path: string, body: object = {}) =>
      request(t.app)
        .post(`${API}${path}`)
        .set('Authorization', `Bearer ${admin}`)
        .set('Idempotency-Key', randomUUID())
        .send(body),
  };

  /** Publishes and waits until the consumer committed it (processed_events, architecture §3.2). */
  async function deliver(eventType: string, payload: Record<string, unknown>): Promise<void> {
    const eventId = randomUUID();
    probe.channel.publish(
      worker.env.RABBITMQ_EXCHANGE,
      eventType,
      Buffer.from(
        JSON.stringify({
          eventId,
          eventType,
          version: 1,
          occurredAt: new Date().toISOString(),
          correlationId: null,
          aggregateType: 'return_request',
          aggregateId: randomUUID(),
          payload,
        }),
      ),
      { persistent: true },
    );
    await waitFor(
      async () =>
        (await knex()('processed_events').where({ consumer: ORDER_ADJUSTMENTS_QUEUE, event_id: eventId }))
          .length === 1,
    );
  }

  /** A delivered order of 150.00 collected (COD) or paid (Kashier), and a return row of its seller order. */
  async function deliveredWithReturn(method: 'cod' | 'kashier') {
    const chain = await fx.insertOrderChain();
    if (method === 'kashier') {
      await knex()('orders')
        .where({ id: chain.orderId })
        .update({ payment_method: 'kashier', payment_expires_at: new Date() });
    }
    const paymentId = await fx.insertPayment(chain.orderId, {
      method,
      status: method === 'cod' ? 'collected' : 'paid',
      collected_amount: '150.00',
      paid_at: method === 'kashier' ? new Date() : null,
    });
    const [row] = await knex()('return_requests')
      .insert({
        return_number: knex().raw(`'R-' || lpad(nextval('return_number_seq')::text, 9, '0')`),
        seller_order_id: chain.sellerOrderId,
        order_id: chain.orderId,
        customer_id: chain.customerId,
        seller_id: chain.sellerId,
        // Terminal, so the fixture never blocks another (the consumer reads only the event).
        status: 'cancelled',
        reason: 'changed_mind',
        return_fee: '50.00',
        return_fee_payer: 'customer',
        agent_share_rate: '0.7000',
        refund_amount: '50.00',
        seller_decision_deadline_at: new Date(),
      })
      .returning<{ id: string }[]>('id');
    if (!row) throw new Error('fixture');
    return { ...chain, paymentId, returnId: row.id };
  }
  type Delivered = Awaited<ReturnType<typeof deliveredWithReturn>>;

  const completed = (d: Delivered, overrides: Record<string, unknown> = {}) => ({
    returnId: d.returnId,
    sellerOrderId: d.sellerOrderId,
    orderId: d.orderId,
    customerId: d.customerId,
    sellerId: d.sellerId,
    paymentMethod: 'cod',
    itemsPaid: '100.00',
    itemsSubtotal: '100.00',
    commissionReversed: '10.00',
    sellerNetReversed: '90.00',
    platformDiscountReversed: '0.00',
    returnFee: '50.00',
    returnFeePayer: 'customer',
    agentId: randomUUID(),
    agentFeeShare: '35.00',
    refundAmount: '50.00',
    refundPayoutEncrypted: null,
    ...overrides,
  });
  const refundsOf = async (paymentId: string) =>
    successBody<(RefundBody & { paymentId: string })[]>(
      await asAdmin.get(`/admin/payments/refunds?limit=50`).expect(200),
    ).data.filter((r) => r.paymentId === paymentId);

  beforeAll(async () => {
    t = await startTestApp();
    fx = orderFixtures(knex());
    box = t.container.resolve<ISecretBox>(TOKENS.SecretBox);
    admin = await signTestAccessToken({ sub: await fx.insertUser('admin'), role: 'admin' });
    const { logger } = createMemoryLogger();
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
    const container = createWorkerContainer(worker);
    await worker.broker.assertExchange(worker.env.RABBITMQ_EXCHANGE);
    const consumers = new EventConsumerHost(worker.broker, worker.db, logger, worker.env);
    for (const handler of createEventHandlers(container)) await consumers.start(handler);
    probe = await AmqpProbe.open(t.resources.workerEnv.RABBITMQ_URL);
  });
  afterAll(async () => {
    await probe.close();
    await closeInfrastructure(worker);
    await t.close();
  });

  it('COD: a manual refund with sealed payout details; the detail opens them; recording keeps the status', async () => {
    const d = await deliveredWithReturn('cod');
    const wallet = { method: 'mobile_wallet', walletNumber: '+201001234567' };
    const sealed = box.seal(JSON.stringify(wallet), refundPayoutAad(d.returnId));
    await deliver('return.completed', completed(d, { refundPayoutEncrypted: sealed }));

    const [refund] = await refundsOf(d.paymentId);
    expect(refund).toMatchObject({
      returnId: d.returnId,
      reason: 'return',
      status: 'pending_manual',
      method: 'manual',
      amount: '50.00',
      hasPayoutDetails: true,
    });
    expect(refund).not.toHaveProperty('payoutDetails');
    const detail = successBody<RefundBody>(
      await asAdmin.get(`/admin/payments/refunds/${refund?.id}`).expect(200),
    ).data;
    expect(detail.payoutDetails).toEqual(wallet);

    const payments = t.container.resolve<IPaymentDirectory>(TOKENS.PaymentDirectory);
    expect((await payments.getRefundsByReturnIds([d.returnId])).get(d.returnId)).toMatchObject({
      status: 'manual',
    });

    flushRetryRefused(await asAdmin.post(`/admin/payments/refunds/${refund?.id}/retry`));
    await asAdmin
      .post(`/admin/payments/refunds/${refund?.id}/record`, { providerRefundRef: 'IPN-778' })
      .expect(200);
    const view = (await payments.getRefundsByReturnIds([d.returnId])).get(d.returnId);
    expect(view?.status).toBe('succeeded');
    expect(view?.refundedAt).toBeInstanceOf(Date);
    expect(await knex()('payments').where({ id: d.paymentId }).first('status', 'refunded_amount')).toEqual({
      status: 'collected',
      refunded_amount: '50.00',
    });
    const [event] = await knex()('events_outbox')
      .where({ event_type: 'payment.refund_recorded', aggregate_id: d.paymentId })
      .select<{ payload: Record<string, unknown> }[]>('payload');
    expect(event?.payload).toMatchObject({
      customerId: d.customerId,
      reason: 'return',
      returnId: d.returnId,
      amount: '50.00',
      newPaymentStatus: null,
    });
  });

  it('Kashier: a refund for the job (K-12); once the job handed it over, retry gives it back, audited, once', async () => {
    const d = await deliveredWithReturn('kashier');
    await deliver('return.completed', completed(d, { paymentMethod: 'kashier' }));
    const [refund] = await refundsOf(d.paymentId);
    expect(refund).toMatchObject({
      reason: 'return',
      status: 'pending_auto',
      method: 'kashier_auto',
      hasPayoutDetails: false,
    });
    expect(refund?.nextAttemptAt).not.toBeNull();
    // As the job leaves a refund it gave up on.
    await knex()('payment_refunds')
      .where({ id: refund?.id })
      .update({ status: 'pending_manual', attempt_count: 5 });

    const retried = successBody<RefundBody>(
      await asAdmin.post(`/admin/payments/refunds/${refund?.id}/retry`).expect(200),
    ).data;
    expect(retried).toMatchObject({ status: 'pending_auto', attemptCount: 0 });
    expect(retried.nextAttemptAt).not.toBeNull();
    const again = await asAdmin.post(`/admin/payments/refunds/${refund?.id}/retry`);
    expect([again.status, errorBody(again).error.code]).toEqual([409, 'REFUND_NOT_RETRYABLE']);
    const [audit] = await knex()('admin_audit_log')
      .where({ action: 'payment_refund.retried', target_id: refund?.id })
      .select<{ changes: unknown }[]>('changes');
    expect(audit?.changes).toEqual({
      before: { status: 'pending_manual' },
      after: { status: 'pending_auto' },
    });
    expect(
      (
        await t.container
          .resolve<IPaymentDirectory>(TOKENS.PaymentDirectory)
          .getRefundsByReturnIds([d.returnId])
      ).get(d.returnId)?.status,
    ).toBe('pending');
  });

  it('stays within what was collected (PA-20), skips nothing to refund, and refuses a COD return without payout details', async () => {
    const d = await deliveredWithReturn('cod');
    const sealed = box.seal('{}', refundPayoutAad(d.returnId));
    await deliver(
      'return.completed',
      completed(d, { refundAmount: '200.00', refundPayoutEncrypted: sealed }),
    );
    expect((await refundsOf(d.paymentId)).map((r) => r.amount)).toEqual(['150.00']);

    const none = await deliveredWithReturn('cod');
    await deliver('return.completed', completed(none, { refundAmount: '0.00' }));
    expect(await refundsOf(none.paymentId)).toEqual([]);

    const missing = await deliveredWithReturn('cod');
    const dlq = deadLetterQueueName(ORDER_ADJUSTMENTS_QUEUE);
    const before = await probe.messageCount(dlq);
    probe.channel.publish(
      worker.env.RABBITMQ_EXCHANGE,
      'return.completed',
      Buffer.from(
        JSON.stringify({
          eventId: randomUUID(),
          eventType: 'return.completed',
          version: 1,
          occurredAt: new Date().toISOString(),
          correlationId: null,
          aggregateType: 'return_request',
          aggregateId: randomUUID(),
          payload: completed(missing),
        }),
      ),
      { persistent: true },
    );
    await waitFor(async () => (await probe.messageCount(dlq)) === before + 1);
    expect(await refundsOf(missing.paymentId)).toEqual([]);
  });

  it('the refund detail of an unknown refund is 404 and needs an admin', async () => {
    expect((await asAdmin.get(`/admin/payments/refunds/0192f5e0-0000-7000-8000-000000000000`)).status).toBe(
      404,
    );
    const customer = await signTestAccessToken({ sub: (await fx.insertCustomer()).userId, role: 'customer' });
    expect(
      (
        await request(t.app)
          .get(`${API}/admin/payments/refunds/0192f5e0-0000-7000-8000-000000000000`)
          .set('Authorization', `Bearer ${customer}`)
      ).status,
    ).toBe(403);
  });
});

/** A COD refund is never retryable: only Kashier refunds go to the job. */
function flushRetryRefused(res: { status: number; body: unknown }): void {
  expect([res.status, (res.body as { error: { code: string } }).error.code]).toEqual([
    409,
    'REFUND_NOT_RETRYABLE',
  ]);
}
