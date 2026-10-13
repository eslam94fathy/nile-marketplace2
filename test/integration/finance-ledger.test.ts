import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEDGER_QUEUE } from '../../src/app/finance/constants';
import { type LedgerBookingService } from '../../src/app/finance/service/ledger-booking.service';
import { type CheckoutResultDto } from '../../src/app/ordering/dto/order-response.dto';
import { TOKENS } from '../../src/lib/di';
import { type EventEnvelope, PermanentEventError } from '../../src/lib/events';
import { signKashierWebhook } from '../../src/pkg/payments';
import { type DeliveryFlow, startDeliveryFlow } from '../helpers/delivery-flow';
import { successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { CAIRO_FEE } from '../helpers/ordering-api';
import { TEST_KASHIER_API_KEY } from '../helpers/test-env';

const SIGNATURE_KEYS = ['amount', 'currency', 'merchantOrderId', 'status', 'transactionId'];

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/* Spec 12 §1.2 (FI-1, FI-3, FI-4): the finance.ledger consumer, end to end and on its own. */
describe('finance: ledger bookings', () => {
  let flow: DeliveryFlow;

  const knex = () => flow.knex();

  /** The account's balance, "0.00" when it doesn't exist yet. */
  const balance = async (accountType: string, ownerId: string | null = null) => {
    const row = await knex()('finance_accounts')
      .where({ account_type: accountType })
      .whereRaw('owner_id IS NOT DISTINCT FROM ?::uuid', [ownerId])
      .first<{ balance: string } | undefined>('balance');
    return row?.balance ?? '0.00';
  };
  const entriesOf = (referenceType: string, referenceId: string) =>
    knex()('ledger_entries as e')
      .join('finance_accounts as a', 'a.id', 'e.account_id')
      .where({ 'e.reference_type': referenceType, 'e.reference_id': referenceId })
      .orderBy('e.id')
      .select<
        {
          account_type: string;
          owner_id: string | null;
          direction: string;
          amount: string;
          entry_type: string;
          source_event_id: string | null;
        }[]
      >('a.account_type', 'a.owner_id', 'e.direction', 'e.amount', 'e.entry_type', 'e.source_event_id');
  /** Every outbox event of this type for the aggregate was committed by finance.ledger. */
  const booked = async (eventType: string, aggregateId: string) => {
    const ids = await knex()('events_outbox')
      .where({ event_type: eventType, aggregate_id: aggregateId })
      .pluck<string[]>('id');
    if (ids.length === 0) return false;
    const done = await knex()('processed_events').where({ consumer: LEDGER_QUEUE }).whereIn('event_id', ids);
    return done.length === ids.length;
  };
  const deliveredPayload = async (sellerOrderId: string) =>
    must((await flow.api.eventsOf('seller_order.delivered', sellerOrderId))[0]);
  const plus = (a: string, b: string) => (Number(a) + Number(b)).toFixed(2);

  const envelope = (
    eventType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): EventEnvelope => ({
    eventId: randomUUID(),
    eventType,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: null,
    aggregateType: eventType === 'order.closed' ? 'order' : 'seller_order',
    aggregateId,
    payload,
  });
  /** Runs the consumer's handler in its own worker transaction (no broker, no dedupe row). */
  const consume = (event: EventEnvelope) =>
    flow.worker.db.run((trx) =>
      flow.workerContainer.resolve<LedgerBookingService>(TOKENS.LedgerBookingService).handle(event, trx),
    );
  const delivered = (overrides: Record<string, unknown> = {}) => {
    const sellerOrderId = randomUUID();
    return envelope('seller_order.delivered', sellerOrderId, {
      sellerOrderId,
      orderId: randomUUID(),
      sellerId: randomUUID(),
      paymentMethod: 'cod',
      subtotal: '100.00',
      commissionRate: '0.1000',
      commission: '10.00',
      sellerNet: '90.00',
      agentId: randomUUID(),
      agentFeeShare: '14.00',
      codCollectedAmount: '100.00',
      deliveryFeeCollected: false,
      deliveryFeeAmount: '0.00',
      deliveredAt: new Date().toISOString(),
      ...overrides,
    });
  };

  beforeAll(async () => {
    flow = await startDeliveryFlow();
  });
  afterAll(async () => {
    await flow.close();
  });

  it('a COD delivery through the agent endpoints books the seller, commission, agent fee and cash', async () => {
    const { soleAgent, order, readyAndAssigned, act, settle } = flow;
    const agent = await soleAgent();
    const revenueBefore = await balance('platform_delivery_revenue');
    const commissionBefore = await balance('platform_commission_revenue');
    const { orderId, sellerOrders } = await order(['100.00']);
    const entry = must(sellerOrders[0]);
    const shipmentId = await readyAndAssigned(entry, agent);
    await act(agent, shipmentId, 'picked-up');
    await act(agent, shipmentId, 'out-for-delivery');
    await act(agent, shipmentId, 'delivered', { codCollectedAmount: plus('100.00', CAIRO_FEE) });
    await settle(
      async () =>
        (await booked('seller_order.delivered', entry.sellerOrderId)) &&
        (await booked('order.closed', orderId)),
    );

    const payload = await deliveredPayload(entry.sellerOrderId);
    const share = String(payload.agentFeeShare);
    const sellerOrder = await knex()('seller_orders')
      .where({ id: entry.sellerOrderId })
      .first<{ commission: string; seller_net: string }>('commission', 'seller_net');
    expect(await entriesOf('seller_order', entry.sellerOrderId)).toEqual([
      expect.objectContaining({
        account_type: 'seller_payable',
        owner_id: entry.sellerId,
        direction: 'credit',
        amount: sellerOrder?.seller_net,
        entry_type: 'seller_net_earned',
      }),
      expect.objectContaining({
        account_type: 'platform_commission_revenue',
        owner_id: null,
        amount: sellerOrder?.commission,
        entry_type: 'commission_earned',
      }),
      expect.objectContaining({
        account_type: 'agent_fee_payable',
        owner_id: agent.agentId,
        direction: 'credit',
        amount: share,
      }),
      expect.objectContaining({
        account_type: 'platform_delivery_revenue',
        direction: 'debit',
        amount: share,
        entry_type: 'agent_fee_earned',
      }),
      expect.objectContaining({
        account_type: 'agent_cod_cash',
        owner_id: agent.agentId,
        amount: '150.00',
        entry_type: 'cod_cash_collected',
      }),
      expect.objectContaining({
        account_type: 'platform_delivery_revenue',
        direction: 'credit',
        amount: CAIRO_FEE,
        entry_type: 'platform_fee_earned',
      }),
    ]);
    expect(await balance('seller_payable', entry.sellerId)).toBe(sellerOrder?.seller_net);
    expect(await balance('agent_fee_payable', agent.agentId)).toBe(share);
    expect(await balance('agent_cod_cash', agent.agentId)).toBe('150.00');
    expect(await balance('platform_commission_revenue')).toBe(
      plus(commissionBefore, must(sellerOrder).commission),
    );
    // Delivery revenue = fee collected − the agent's share.
    expect(await balance('platform_delivery_revenue')).toBe(
      plus(revenueBefore, plus(CAIRO_FEE, `-${share}`)),
    );
    // A COD order.closed books nothing: the fee was booked when collected.
    expect(await entriesOf('order', orderId)).toEqual([]);
  });

  it('a Kashier order books the delivery fee when it closes (row 7)', async () => {
    const { api, soleAgent, readyAndAssigned, act, settle } = flow;
    const agent = await soleAgent();
    const buyer = await api.customer();
    const variant = await api.listedVariant({ price: '100.00' });
    await api.fillCart(buyer.customerId, [{ variantId: variant.variantId, quantity: 1 }]);
    const checkout = await api.as(buyer.token).checkout({
      addressId: buyer.addressId,
      paymentMethod: 'kashier',
      expectedTotal: plus('100.00', CAIRO_FEE),
    });
    expect(checkout.status).toBe(201);
    const { order } = successBody<CheckoutResultDto>(checkout).data;
    const payment = await knex()('payments').where({ order_id: order.id }).first<{ id: string }>('id');
    const data = {
      signatureKeys: SIGNATURE_KEYS,
      merchantOrderId: must(payment).id,
      transactionId: `TX-${randomUUID()}`,
      status: 'SUCCESS',
      amount: 150,
      currency: 'EGP',
    };
    const paid = await request(flow.t.app)
      .post(`${API}/webhooks/kashier`)
      .set('Content-Type', 'application/json')
      .set('x-kashier-signature', signKashierWebhook(data, SIGNATURE_KEYS, TEST_KASHIER_API_KEY))
      .send(JSON.stringify({ event: 'pay', data }));
    expect(paid.status).toBe(200);
    const sellerOrderId = must(order.sellerOrders[0]).id;
    await settle(async () => (await flow.sellerOrderStatus(sellerOrderId)) === 'placed');

    const revenueBefore = await balance('platform_delivery_revenue');
    const shipmentId = await readyAndAssigned({ sellerToken: variant.sellerToken, sellerOrderId }, agent);
    await act(agent, shipmentId, 'picked-up');
    await act(agent, shipmentId, 'out-for-delivery');
    await act(agent, shipmentId, 'delivered');
    await settle(
      async () =>
        (await booked('seller_order.delivered', sellerOrderId)) && (await booked('order.closed', order.id)),
    );

    const share = String((await deliveredPayload(sellerOrderId)).agentFeeShare);
    expect((await entriesOf('seller_order', sellerOrderId)).map((e) => e.account_type)).toEqual([
      'seller_payable',
      'platform_commission_revenue',
      'agent_fee_payable',
      'platform_delivery_revenue',
    ]);
    expect(await entriesOf('order', order.id)).toEqual([
      expect.objectContaining({
        account_type: 'platform_delivery_revenue',
        direction: 'credit',
        amount: CAIRO_FEE,
        entry_type: 'platform_fee_earned',
      }),
    ]);
    expect(await balance('agent_cod_cash', agent.agentId)).toBe('0.00');
    expect(await balance('platform_delivery_revenue')).toBe(
      plus(revenueBefore, plus(CAIRO_FEE, `-${share}`)),
    );
  });

  it('a redelivered event is booked once (dedupe on eventId, FI-4)', async () => {
    const { soleAgent, order, readyAndAssigned, act, settle } = flow;
    const agent = await soleAgent();
    const { sellerOrders } = await order(['80.00']);
    const entry = must(sellerOrders[0]);
    const shipmentId = await readyAndAssigned(entry, agent);
    await act(agent, shipmentId, 'picked-up');
    await act(agent, shipmentId, 'out-for-delivery');
    await act(agent, shipmentId, 'delivered', { codCollectedAmount: plus('80.00', CAIRO_FEE) });
    await settle(() => booked('seller_order.delivered', entry.sellerOrderId));
    const before = (await entriesOf('seller_order', entry.sellerOrderId)).length;

    // The same outbox row (same eventId) published again; finance.ledger sees it and skips it.
    const [event] = await knex()('events_outbox')
      .where({ event_type: 'seller_order.delivered', aggregate_id: entry.sellerOrderId })
      .update({ dispatched_at: null, next_attempt_at: new Date() })
      .returning<{ id: string }[]>('id');
    const eventId = must(event).id;
    await settle(() =>
      Promise.resolve(
        flow.workerLogs
          .entries()
          .some(
            (line) =>
              line.message === 'duplicate event skipped' &&
              line.consumer === LEDGER_QUEUE &&
              line.eventId === eventId,
          ),
      ),
    );
    expect(await entriesOf('seller_order', entry.sellerOrderId)).toHaveLength(before);
    expect(await balance('agent_cod_cash', agent.agentId)).toBe(plus('80.00', CAIRO_FEE));
  });

  it('order.closed before the deliveries: delivery revenue still ends at fee − shares', async () => {
    const before = await balance('platform_delivery_revenue');
    const orderId = randomUUID();
    await consume(
      envelope('order.closed', orderId, { orderId, paymentMethod: 'kashier', deliveryFee: '60.00' }),
    );
    expect(await balance('platform_delivery_revenue')).toBe(plus(before, '60.00'));
    for (const sellerOrder of [delivered(), delivered()]) {
      sellerOrder.payload = {
        ...sellerOrder.payload,
        orderId,
        paymentMethod: 'kashier',
        codCollectedAmount: null,
      };
      await consume(sellerOrder);
    }
    expect(await balance('platform_delivery_revenue')).toBe(plus(before, '32.00'));
  });

  it('a COD fee never collected (S-3) leaves delivery revenue down by the shares (FI-1)', async () => {
    const before = await balance('platform_delivery_revenue');
    const orderId = randomUUID();
    await consume(delivered({ orderId }));
    await consume(delivered({ orderId }));
    await consume(envelope('order.closed', orderId, { orderId, paymentMethod: 'cod', deliveryFee: '60.00' }));
    expect(await balance('platform_delivery_revenue')).toBe(plus(before, '-28.00'));
  });

  it('parallel bookings on the same new accounts never deadlock and add up exactly (FI-3)', async () => {
    const sellerId = randomUUID();
    const agentId = randomUUID();
    const events = Array.from({ length: 8 }, () => delivered({ sellerId, agentId }));
    await Promise.all(events.map(consume));
    expect(await balance('seller_payable', sellerId)).toBe('720.00');
    expect(await balance('agent_fee_payable', agentId)).toBe('112.00');
    expect(await balance('agent_cod_cash', agentId)).toBe('800.00');

    // balance_after forms one running sum per account, whatever the commit order.
    const chain = await knex()('ledger_entries as e')
      .join('finance_accounts as a', 'a.id', 'e.account_id')
      .where({ 'a.account_type': 'agent_cod_cash', 'a.owner_id': agentId })
      .orderBy('e.balance_after')
      .pluck<string[]>('e.balance_after');
    expect(chain).toEqual(['100.00', '200.00', '300.00', '400.00', '500.00', '600.00', '700.00', '800.00']);
  });

  it('an unusable payload is permanent and writes nothing (FI-4)', async () => {
    const event = delivered({ sellerNet: 'ninety' });
    await expect(consume(event)).rejects.toBeInstanceOf(PermanentEventError);
    expect(await entriesOf('seller_order', event.aggregateId)).toEqual([]);
  });
});
