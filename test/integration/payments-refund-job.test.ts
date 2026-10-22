import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPaymentsJobs } from '../../src/app/payments';
import { createWorkerContainer } from '../../src/container';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { type FakePaymentGateway } from '../../src/pkg/payments';
import { createMemoryLogger, type MemoryLogWriter } from '../helpers/memory-logger';
import { orderFixtures } from '../helpers/order-fixtures';
import { startTestApp, type TestApp } from '../helpers/test-app';

const MINUTE = 60_000;

interface RefundRow {
  status: string;
  attempt_count: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  provider_refund_ref: string | null;
  succeeded_at: Date | null;
}

/*
 * Spec 10 UC-PA-6 with K-10…K-12 on real Postgres, against the fake gateway: the job claims due Kashier
 * refunds, calls the provider outside any transaction and applies the result; it spaces refunds of one
 * payment, refuses replayed answers, backs off on transient failures, and hands everything else to an
 * admin. Nothing is re-sent blindly.
 */
describe('payments: the refund job', () => {
  let t: TestApp;
  let worker: WorkerInfrastructure;
  let logs: MemoryLogWriter;
  let fake: FakePaymentGateway;
  let run: () => Promise<number>;
  let fx: ReturnType<typeof orderFixtures>;
  const knex = () => t.infra.db.knex;

  /** A paid Kashier order of 150.00 and its payment. */
  async function paidKashier() {
    const chain = await fx.insertOrderChain();
    await knex()('orders')
      .where({ id: chain.orderId })
      .update({ payment_method: 'kashier', payment_expires_at: new Date() });
    const paymentId = await fx.insertPayment(chain.orderId, {
      method: 'kashier',
      status: 'paid',
      collected_amount: '150.00',
      paid_at: new Date(),
    });
    return { ...chain, paymentId };
  }

  /** A Kashier refund due now (or `overrides`), as the flags create it. */
  async function due(
    paymentId: string,
    amount: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const [row] = await knex()('payment_refunds')
      .insert({
        payment_id: paymentId,
        seller_order_id: null,
        amount,
        reason: 'seller_order_cancelled',
        status: 'pending_auto',
        method: 'kashier_auto',
        attempt_count: 0,
        next_attempt_at: new Date(Date.now() - 1000),
        ...overrides,
      })
      .returning<{ id: string }[]>('id');
    if (!row) throw new Error('fixture');
    return row.id;
  }

  const refund = async (id: string): Promise<RefundRow> => {
    const row = await knex()('payment_refunds')
      .where({ id })
      .first<RefundRow | undefined>(
        'status',
        'attempt_count',
        'next_attempt_at',
        'last_error',
        'provider_refund_ref',
        'succeeded_at',
      );
    if (!row) throw new Error(`refund ${id} not found`);
    return row;
  };
  const payment = (id: string) =>
    knex()('payments')
      .where({ id })
      .first<{ status: string; refunded_amount: string }>('status', 'refunded_amount');
  /** Moves a refund's last change into the past, out of the K-11 spacing window. */
  const age = (id: string, minutes: number) =>
    knex()('payment_refunds')
      .where({ id })
      .update({ updated_at: new Date(Date.now() - minutes * MINUTE) });

  beforeAll(async () => {
    t = await startTestApp();
    fx = orderFixtures(knex());
    const memory = createMemoryLogger();
    logs = memory.writer;
    worker = await createWorkerInfrastructure(t.resources.workerEnv, memory.logger);
    fake = worker.paymentGateway as FakePaymentGateway;
    const [job] = createPaymentsJobs(createWorkerContainer(worker), worker.env);
    if (!job) throw new Error('no refund job');
    run = () => job.run();
  });
  afterAll(async () => {
    await closeInfrastructure(worker);
    await t.close();
  });

  it('refunds through the provider: succeeded, the payment refunded, payment.refunded published', async () => {
    const p = await paidKashier();
    const id = await due(p.paymentId, '50.00');
    await run();
    expect(fake.refundCalls.at(-1)).toEqual({
      merchantOrderId: p.paymentId,
      amount: '50.00',
      reason: 'Nile refund seller_order_cancelled',
    });
    const row = await refund(id);
    expect(row).toMatchObject({ status: 'succeeded', attempt_count: 1, last_error: null });
    expect(row.provider_refund_ref).toMatch(/^FAKE-RF-/);
    expect(row.succeeded_at).toBeInstanceOf(Date);
    expect(await payment(p.paymentId)).toEqual({ status: 'partially_refunded', refunded_amount: '50.00' });
    const [event] = await knex()('events_outbox')
      .where({ event_type: 'payment.refunded', aggregate_id: p.paymentId })
      .select<{ payload: Record<string, unknown> }[]>('payload');
    expect(event?.payload).toMatchObject({
      refundId: id,
      customerId: p.customerId,
      reason: 'seller_order_cancelled',
      returnId: null,
      amount: '50.00',
      newPaymentStatus: 'partially_refunded',
    });
  });

  it('spaces refunds of one payment (K-11), then refunds the rest in full', async () => {
    const p = await paidKashier();
    const first = await due(p.paymentId, '50.00');
    const second = await due(p.paymentId, '100.00');
    const calls = fake.refundCalls.length;
    await run();
    expect(fake.refundCalls.length - calls).toBe(1);
    expect((await refund(first)).status).toBe('succeeded');
    const waiting = await refund(second);
    expect(waiting).toMatchObject({ status: 'pending_auto', attempt_count: 0 });
    expect(waiting.next_attempt_at?.getTime()).toBeGreaterThan(Date.now() + MINUTE);

    await age(first, 3);
    await knex()('payment_refunds')
      .where({ id: second })
      .update({ next_attempt_at: new Date(Date.now() - 1000) });
    await run();
    expect((await refund(second)).status).toBe('succeeded');
    expect(await payment(p.paymentId)).toEqual({ status: 'refunded', refunded_amount: '150.00' });
  });

  it('a replayed answer is not taken as a refund: the admin checks it (K-11)', async () => {
    const p = await paidKashier();
    const first = await due(p.paymentId, '50.00');
    await run();
    await age(first, 3);
    const second = await due(p.paymentId, '50.00');
    fake.scriptRefund('replay');
    await run();
    const row = await refund(second);
    expect(row).toMatchObject({ status: 'pending_manual', provider_refund_ref: null });
    expect(row.last_error).toMatch(/^PAYMENT_REFUND_REPLAYED/);
    expect(await payment(p.paymentId)).toEqual({ status: 'partially_refunded', refunded_amount: '50.00' });
    expect(logs.entries().some((e) => e.event === 'PAYMENT_REFUND_REPLAYED')).toBe(true);
  });

  it('backs off on a transient failure and gives up after the last attempt (K-12)', async () => {
    const p = await paidKashier();
    const id = await due(p.paymentId, '20.00');
    fake.scriptRefund('unavailable');
    await run();
    const retry = await refund(id);
    expect(retry).toMatchObject({ status: 'pending_auto', attempt_count: 1 });
    expect(retry.last_error).toContain('fake: refund unavailable');
    expect(retry.next_attempt_at?.getTime()).toBeGreaterThan(Date.now() + 30_000);

    await knex()('payment_refunds')
      .where({ id })
      .update({ attempt_count: 4, next_attempt_at: new Date(Date.now() - 1000) });
    fake.scriptRefund('unavailable');
    await run();
    const gaveUp = await refund(id);
    expect(gaveUp).toMatchObject({ status: 'pending_manual', attempt_count: 5, next_attempt_at: null });
    expect(gaveUp.last_error).toMatch(/^PAYMENT_REFUND_GAVE_UP/);
  });

  it('a refusal and an unknown outcome go to the admin at once, never re-sent (K-10, K-12)', async () => {
    const refused = await due((await paidKashier()).paymentId, '10.00');
    const unknown = await due((await paidKashier()).paymentId, '10.00');
    fake.scriptRefund('rejected', 'unknown_outcome');
    await run();
    const outcomes = [await refund(refused), await refund(unknown)];
    expect(outcomes.map((r) => r.status)).toEqual(['pending_manual', 'pending_manual']);
    expect(outcomes.map((r) => r.last_error?.split(':')[0]).sort()).toEqual([
      'PAYMENT_REFUND_OUTCOME_UNKNOWN',
      'PAYMENT_REFUND_REJECTED',
    ]);
    const calls = fake.refundCalls.length;
    await run();
    expect(fake.refundCalls.length).toBe(calls);
  });

  it('holds the other refunds of a payment while one waits for an admin with an unknown outcome (K-13)', async () => {
    const p = await paidKashier();
    const unknown = await due(p.paymentId, '30.00');
    fake.scriptRefund('unknown_outcome');
    await run();
    expect((await refund(unknown)).status).toBe('pending_manual');
    await age(unknown, 10);
    const next = await due(p.paymentId, '30.00');
    const calls = fake.refundCalls.length;
    await run();
    expect(fake.refundCalls.length).toBe(calls);
    expect(await refund(next)).toMatchObject({ status: 'pending_auto', attempt_count: 0 });

    // The admin checked the dashboard and recorded it; once out of the spacing window the next one runs.
    await knex()('payment_refunds')
      .where({ id: unknown })
      .update({
        status: 'recorded',
        recorded_by_user_id: await fx.insertUser('admin'),
        recorded_at: new Date(),
        provider_refund_ref: 'TX-DASHBOARD',
      });
    await age(unknown, 10);
    await knex()('payment_refunds')
      .where({ id: next })
      .update({ next_attempt_at: new Date(Date.now() - 1000) });
    const before = fake.refundCalls.length;
    await run();
    expect(fake.refundCalls.length).toBe(before + 1);
    expect((await refund(next)).status).not.toBe('pending_auto');
  });

  it('a refund left processing is handed to the admin without a call (K-10)', async () => {
    const p = await paidKashier();
    const id = await due(p.paymentId, '10.00', { status: 'processing', attempt_count: 1 });
    await age(id, 20);
    const calls = fake.refundCalls.length;
    await run();
    const row = await refund(id);
    expect(row.status).toBe('pending_manual');
    expect(row.last_error).toMatch(/^PAYMENT_REFUND_OUTCOME_UNKNOWN/);
    expect(fake.refundCalls.length).toBe(calls);
  });
});
