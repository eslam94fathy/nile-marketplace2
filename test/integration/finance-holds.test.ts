import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFinanceJobs } from '../../src/app/finance';
import { type SellerBalanceDto, type SellerHoldDto } from '../../src/app/finance/dto/finance-response.dto';
import { InsufficientBalanceError } from '../../src/app/finance/service/ledger.service';
import { type LedgerBookingService } from '../../src/app/finance/service/ledger-booking.service';
import { createWorkerContainer } from '../../src/container';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { TOKENS } from '../../src/lib/di';
import { type EventEnvelope, PermanentEventError } from '../../src/lib/events';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { createMemoryLogger } from '../helpers/memory-logger';
import { orderFixtures } from '../helpers/order-fixtures';
import { startTestApp, type TestApp } from '../helpers/test-app';

const DAY_MS = 86_400_000;

/*
 * Spec 12 §8 (R-16, FI-12, FI-17…FI-19) on real Postgres: a delivery's hold, the release job, a return's
 * debits split between pending and available, refunds paid for returns, and no payout while a seller
 * owes the platform.
 */
describe('finance: holding period, returns and refunds', () => {
  let t: TestApp;
  let worker: WorkerInfrastructure;
  let bookings: LedgerBookingService;
  let release: () => Promise<unknown>;
  let fx: ReturnType<typeof orderFixtures>;
  let adminToken: string;
  const knex = () => t.infra.db.knex;

  const get = (token: string, path: string) =>
    request(t.app).get(`${API}${path}`).set('Authorization', `Bearer ${token}`);
  const consume = (eventType: string, payload: Record<string, unknown>) => {
    const envelope: EventEnvelope = {
      eventId: randomUUID(),
      eventType,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: null,
      aggregateType: 'seller_order',
      aggregateId: randomUUID(),
      payload,
    };
    return worker.db.run((trx) => bookings.handle(envelope, trx));
  };
  const balance = async (accountType: string, ownerId: string) =>
    (
      await knex()('finance_accounts')
        .where({ account_type: accountType, owner_id: ownerId })
        .first<{ balance: string } | undefined>('balance')
    )?.balance ?? '0.00';
  const hold = (sellerOrderId: string) =>
    knex()('seller_order_holds')
      .where({ seller_order_id: sellerOrderId })
      .first<{ held_amount: string; release_after: Date; released_at: Date | null }>(
        'held_amount',
        'release_after',
        'released_at',
      );

  /** A seller order delivered `daysAgo` days ago and booked by finance.ledger (net 90, COD). */
  async function delivered(daysAgo: number, sellerId?: string) {
    const chain = await fx.insertOrderChain();
    const seller = sellerId ?? chain.sellerId;
    const sellerOrderId =
      sellerId === undefined ? chain.sellerOrderId : await fx.insertSellerOrder(chain.orderId, seller);
    const deliveredAt = new Date(Date.now() - daysAgo * DAY_MS);
    await consume('seller_order.delivered', {
      sellerOrderId,
      orderId: chain.orderId,
      sellerId: seller,
      paymentMethod: 'cod',
      subtotal: '100.00',
      commissionRate: '0.1000',
      commission: '10.00',
      sellerNet: '90.00',
      agentId: randomUUID(),
      agentFeeShare: '35.00',
      codCollectedAmount: '150.00',
      deliveryFeeCollected: true,
      deliveryFeeAmount: '50.00',
      deliveredAt: deliveredAt.toISOString(),
    });
    const user = await knex()('sellers').where({ id: seller }).first<{ user_id: string }>('user_id');
    const token = await signTestAccessToken({ sub: user?.user_id ?? '', role: 'seller' });
    return { ...chain, sellerId: seller, sellerOrderId, deliveredAt, token };
  }
  type Delivered = Awaited<ReturnType<typeof delivered>>;

  /** A return row of the seller order (the views and the job read only its status). */
  async function returnOf(d: Delivered, status: string) {
    const [row] = await knex()('return_requests')
      .insert({
        return_number: knex().raw(`'R-' || lpad(nextval('return_number_seq')::text, 9, '0')`),
        seller_order_id: d.sellerOrderId,
        order_id: d.orderId,
        customer_id: d.customerId,
        seller_id: d.sellerId,
        status,
        reason: 'damaged',
        return_fee: '30.00',
        return_fee_payer: 'seller',
        agent_share_rate: '0.7000',
        refund_amount: '50.00',
        seller_decision_deadline_at: new Date(),
      })
      .returning<{ id: string }[]>('id');
    if (!row) throw new Error('fixture');
    return row.id;
  }

  /** A seller-fault return of half the order: net 45 and commission 5 back, fee 30 from the seller. */
  const returnCompleted = (d: Delivered, returnId: string) =>
    consume('return.completed', {
      returnId,
      sellerOrderId: d.sellerOrderId,
      orderId: d.orderId,
      customerId: d.customerId,
      sellerId: d.sellerId,
      paymentMethod: 'cod',
      itemsPaid: '50.00',
      itemsSubtotal: '50.00',
      commissionReversed: '5.00',
      sellerNetReversed: '45.00',
      platformDiscountReversed: '0.00',
      returnFee: '30.00',
      returnFeePayer: 'seller',
      agentId: randomUUID(),
      agentFeeShare: '21.00',
      refundAmount: '50.00',
      refundPayoutEncrypted: null,
    });
  const refundRecorded = (d: Delivered, returnId: string, amount = '50.00') =>
    consume('payment.refund_recorded', {
      paymentId: randomUUID(),
      orderId: d.orderId,
      customerId: d.customerId,
      refundId: randomUUID(),
      returnId,
      reason: 'return',
      amount,
      newPaymentStatus: 'partially_refunded',
    });

  beforeAll(async () => {
    t = await startTestApp();
    fx = orderFixtures(knex());
    adminToken = await signTestAccessToken({ sub: await fx.insertUser('admin'), role: 'admin' });
    worker = await createWorkerInfrastructure(t.resources.workerEnv, createMemoryLogger().logger);
    const container = createWorkerContainer(worker);
    bookings = container.resolve<LedgerBookingService>(TOKENS.LedgerBookingService);
    const [job] = createFinanceJobs(container, worker.env);
    if (!job) throw new Error('no hold release job');
    release = () => job.run();
  });
  afterAll(async () => {
    await closeInfrastructure(worker);
    await t.close();
  });

  it('a delivery is held until the return window ends; the seller sees it as pending (§8.2, §8.6)', async () => {
    const d = await delivered(1);
    expect(await hold(d.sellerOrderId)).toEqual({
      held_amount: '90.00',
      release_after: new Date(d.deliveredAt.getTime() + 14 * DAY_MS),
      released_at: null,
    });
    const view = successBody<SellerBalanceDto>(await get(d.token, '/seller/finance/balance')).data;
    expect([view.available, view.pending]).toEqual(['0.00', '90.00']);

    const holds = successBody<SellerHoldDto[]>(await get(d.token, '/seller/finance/holds'));
    const order = await knex()('orders')
      .where({ id: d.orderId })
      .first<{ order_number: string }>('order_number');
    expect(holds.data).toEqual([
      {
        sellerOrderId: d.sellerOrderId,
        orderNumber: order?.order_number,
        heldAmount: '90.00',
        releaseAfter: new Date(d.deliveredAt.getTime() + 14 * DAY_MS).toISOString(),
        blockedByReturn: false,
      },
    ]);
    expect(holds.meta).toMatchObject({ hasMore: false });
    expect((await get(d.token, '/seller/finance/holds?sort=amount')).status).toBe(400);
    expect((await get(adminToken, '/seller/finance/holds')).status).toBe(403);
  });

  it('the job releases holds past their window, except while a return is open (§8.3)', async () => {
    const due = await delivered(15);
    const blocked = await delivered(15);
    const fresh = await delivered(2);
    await returnOf(blocked, 'requested');

    await release();
    expect((await hold(due.sellerOrderId))?.released_at).not.toBeNull();
    expect([
      await balance('seller_payable', due.sellerId),
      await balance('seller_pending', due.sellerId),
    ]).toEqual(['90.00', '0.00']);
    expect((await hold(blocked.sellerOrderId))?.released_at).toBeNull();
    expect((await hold(fresh.sellerOrderId))?.released_at).toBeNull();
    const view = successBody<SellerHoldDto[]>(await get(blocked.token, '/seller/finance/holds')).data;
    expect(view.map((h) => h.blockedByReturn)).toEqual([true]);
    // Released holds leave the view; a second run releases nothing twice.
    expect(successBody<SellerHoldDto[]>(await get(due.token, '/seller/finance/holds')).data).toEqual([]);
    await release();
    expect(await balance('seller_payable', due.sellerId)).toBe('90.00');
  });

  it('a return takes its seller debits from the hold first; the refund then settles the customer (FI-18, FI-19)', async () => {
    const d = await delivered(3);
    const returnId = await returnOf(d, 'cancelled');

    // A refund before its return would take the customer's account below 0: refused, so retried (FI-15).
    const early = await refundRecorded(d, returnId).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(InsufficientBalanceError);
    expect(early).not.toBeInstanceOf(PermanentEventError);

    await returnCompleted(d, returnId);
    // 45 net + 30 fee = 75 from the 90 held; 15 stays held.
    expect((await hold(d.sellerOrderId))?.held_amount).toBe('15.00');
    expect([
      await balance('seller_pending', d.sellerId),
      await balance('seller_payable', d.sellerId),
    ]).toEqual(['15.00', '0.00']);
    expect(await balance('customer_refund_payable', d.customerId)).toBe('50.00');
    const totals = await knex()('ledger_entries')
      .where({ reference_type: 'return', reference_id: returnId })
      .select('direction')
      .sum<{ direction: string; sum: string }[]>('amount')
      .groupBy('direction')
      .orderBy('direction');
    expect(totals.map((r) => [r.direction, r.sum])).toEqual([
      ['credit', '101.00'],
      ['debit', '101.00'],
    ]);

    await refundRecorded(d, returnId);
    expect(await balance('customer_refund_payable', d.customerId)).toBe('0.00');
    // Refunds of other reasons book nothing (§8.5).
    await consume('payment.refunded', {
      paymentId: randomUUID(),
      orderId: d.orderId,
      customerId: d.customerId,
      refundId: randomUUID(),
      returnId: null,
      reason: 'seller_order_cancelled',
      amount: '50.00',
      newPaymentStatus: 'refunded',
    });
    expect(await balance('customer_refund_payable', d.customerId)).toBe('0.00');
  });

  it('a platform coupon books its cost to platform_promotions and a return gives it back (rows 8, 11, FI-20)', async () => {
    const promotions = async () =>
      (
        await knex()('finance_accounts')
          .where({ account_type: 'platform_promotions' })
          .whereNull('owner_id')
          .first<{ balance: string } | undefined>('balance')
      )?.balance ?? '0.00';
    const start = Number(await promotions());
    const chain = await fx.insertOrderChain();
    await consume('seller_order.delivered', {
      sellerOrderId: chain.sellerOrderId,
      orderId: chain.orderId,
      sellerId: chain.sellerId,
      paymentMethod: 'kashier',
      subtotal: '100.00',
      commissionRate: '0.1000',
      commission: '10.00',
      sellerNet: '90.00',
      discountAmount: '10.00',
      discountFunding: 'platform',
      platformDiscount: '10.00',
      agentId: randomUUID(),
      agentFeeShare: '0.00',
      codCollectedAmount: null,
      deliveryFeeCollected: false,
      deliveryFeeAmount: '0.00',
      deliveredAt: new Date().toISOString(),
    });
    expect(Number(await promotions())).toBeCloseTo(start - 10, 2);
    const entries = await knex()('ledger_entries')
      .where({
        reference_type: 'seller_order',
        reference_id: chain.sellerOrderId,
        entry_type: 'promotion_funded',
      })
      .select<{ direction: string; amount: string }[]>('direction', 'amount');
    expect(entries).toEqual([{ direction: 'debit', amount: '10.00' }]);

    const d = { ...chain, deliveredAt: new Date(), token: '' };
    const returnId = await returnOf(d, 'cancelled');
    await consume('return.completed', {
      returnId,
      sellerOrderId: chain.sellerOrderId,
      orderId: chain.orderId,
      customerId: chain.customerId,
      sellerId: chain.sellerId,
      paymentMethod: 'kashier',
      itemsPaid: '45.00',
      itemsSubtotal: '50.00',
      commissionReversed: '5.00',
      sellerNetReversed: '45.00',
      platformDiscountReversed: '5.00',
      returnFee: '0.00',
      returnFeePayer: 'seller',
      agentId: randomUUID(),
      agentFeeShare: '0.00',
      refundAmount: '45.00',
      refundPayoutEncrypted: null,
    });
    expect(Number(await promotions())).toBeCloseTo(start - 5, 2);
  });

  it('after the release a return debits available, which may go negative; no payout then (FI-12, §8.1)', async () => {
    const first = await delivered(20);
    await release();
    expect(await balance('seller_payable', first.sellerId)).toBe('90.00');
    const pay = (amount: string, ref: string) =>
      request(t.app)
        .post(`${API}/admin/finance/payouts`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          payeeType: 'seller',
          payeeId: first.sellerId,
          amount,
          externalReference: ref,
          paidAt: new Date(Date.now() - DAY_MS).toISOString(),
        });
    expect((await pay('60.00', `P-${randomUUID()}`)).status).toBe(201);

    await returnCompleted(first, await returnOf(first, 'cancelled'));
    expect(await balance('seller_payable', first.sellerId)).toBe('-45.00');
    const view = successBody<SellerBalanceDto>(await get(first.token, '/seller/finance/balance')).data;
    expect([view.available, view.pending]).toEqual(['-45.00', '0.00']);

    const refused = await pay('0.01', `P-${randomUUID()}`);
    expect([refused.status, errorBody(refused).error.code]).toEqual([422, 'PAYOUT_EXCEEDS_BALANCE']);

    // A later delivery's release pays the debt back first.
    await delivered(20, first.sellerId);
    await release();
    expect(await balance('seller_payable', first.sellerId)).toBe('45.00');
    expect((await pay('45.00', `P-${randomUUID()}`)).status).toBe(201);
  });
});
