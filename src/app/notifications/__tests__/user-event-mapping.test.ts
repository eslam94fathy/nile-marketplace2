import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type EventEnvelope, PermanentEventError } from '../../../lib/events';
import { type NotificationParty } from '../../ordering';
import { mapUserEvent, type NotificationDraft } from '../service/user-event-mapping';

const ORDER = randomUUID();
const SO_A = randomUUID();
const SO_B = randomUUID();
const CUSTOMER = randomUUID();
const SELLER_A = randomUUID();
const SELLER_B = randomUUID();
const AGENT = randomUUID();
const SHIPMENT = randomUUID();
const N = 'NM-000000123';

const party = (sellerOrders: NotificationParty['sellerOrders']): NotificationParty => ({
  orderId: ORDER,
  orderNumber: N,
  customerId: CUSTOMER,
  status: 'placed',
  sellerOrders,
});
const one = party([{ sellerOrderId: SO_A, sellerId: SELLER_A, status: 'placed' }]);
const two = party([
  { sellerOrderId: SO_A, sellerId: SELLER_A, status: 'placed' },
  { sellerOrderId: SO_B, sellerId: SELLER_B, status: 'placed' },
]);

const envelope = (eventType: string, payload: Record<string, unknown> = {}): EventEnvelope => ({
  eventId: randomUUID(),
  eventType,
  version: 1,
  occurredAt: new Date().toISOString(),
  correlationId: null,
  aggregateType: 'x',
  aggregateId: randomUUID(),
  payload,
});

/** [recipient, type, category, title, body, link] for compact assertions. */
const rows = (drafts: NotificationDraft[]) =>
  drafts.map((d) => [`${d.recipient.kind}:${d.recipient.id}`, d.type, d.category, d.title, d.body, d.link]);

describe('mapUserEvent (spec 13 §8.2)', () => {
  it('order.placed: the customer, and every seller whose order is live', () => {
    const mixed = party([
      { sellerOrderId: SO_A, sellerId: SELLER_A, status: 'placed' },
      { sellerOrderId: SO_B, sellerId: SELLER_B, status: 'pending_payment' },
    ]);
    expect(rows(mapUserEvent(envelope('order.placed', { orderId: ORDER }), mixed))).toEqual([
      [
        `customer:${CUSTOMER}`,
        'order_placed',
        'orders',
        'Order placed',
        `Order #${N} is confirmed.`,
        `/orders/${ORDER}`,
      ],
      [
        `seller:${SELLER_A}`,
        'seller_order_received',
        'orders',
        'New order',
        `Order #${N} is waiting for you to accept it.`,
        `/seller/orders/${SO_A}`,
      ],
    ]);
  });

  it('accepted: the whole order with one seller, "part of" with several (NO-13)', () => {
    const accepted = envelope('seller_order.accepted', { sellerOrderId: SO_A });
    expect(mapUserEvent(accepted, one).map((d) => d.body)).toEqual([`Order #${N} was accepted.`]);
    expect(mapUserEvent(accepted, two).map((d) => d.body)).toEqual([`Part of order #${N} was accepted.`]);
  });

  it('cancelled: customer for any reason but an unpaid order; the seller unless it cancelled or never saw it (NO-14)', () => {
    const cancelled = (reason: string, previousStatus = 'placed') =>
      rows(
        mapUserEvent(
          envelope('seller_order.cancelled', {
            sellerOrderId: SO_A,
            sellerId: SELLER_A,
            reason,
            previousStatus,
          }),
          two,
        ),
      ).map(([recipient, , , , body]) => [recipient, body]);
    const toCustomer = [`customer:${CUSTOMER}`, `Part of order #${N} was cancelled.`];
    const toSeller = [`seller:${SELLER_A}`, `Order #${N} was cancelled.`];
    expect(cancelled('customer_cancelled')).toEqual([toCustomer, toSeller]);
    expect(cancelled('seller_acceptance_timeout')).toEqual([toCustomer, toSeller]);
    expect(cancelled('seller_cancelled')).toEqual([toCustomer]);
    expect(cancelled('payment_expired', 'pending_payment')).toEqual([]);
    expect(cancelled('payment_failed', 'pending_payment')).toEqual([]);
  });

  it('payment.failed and payment.expired: payment_failed to the customer', () => {
    for (const type of ['payment.failed', 'payment.expired']) {
      expect(rows(mapUserEvent(envelope(type, { orderId: ORDER }), one))).toEqual([
        [
          `customer:${CUSTOMER}`,
          'payment_failed',
          'orders',
          'Payment not completed',
          `Order #${N} was not paid.`,
          `/orders/${ORDER}`,
        ],
      ]);
    }
  });

  it('shipments: assigned to the agent, the rest to the customer under `shipments`', () => {
    expect(
      rows(mapUserEvent(envelope('shipment.assigned', { shipmentId: SHIPMENT, agentId: AGENT }), undefined)),
    ).toEqual([
      [
        `agent:${AGENT}`,
        'shipment_assigned',
        'shipments',
        'New pickup',
        'A new shipment is assigned to you.',
        `/agent/shipments/${SHIPMENT}`,
      ],
    ]);
    const forCustomer = (type: string) => mapUserEvent(envelope(type, { sellerOrderId: SO_A }), one)[0];
    expect(forCustomer('shipment.out_for_delivery')).toMatchObject({
      type: 'out_for_delivery',
      category: 'shipments',
      body: `Order #${N} is out for delivery.`,
    });
    expect(forCustomer('shipment.attempt_failed')).toMatchObject({
      type: 'delivery_attempt_failed',
      body: `We couldn't deliver order #${N}.`,
    });
    expect(forCustomer('seller_order.delivered')).toMatchObject({
      type: 'delivered',
      category: 'shipments',
      body: `Order #${N} was delivered.`,
    });
  });

  it('texts never carry names, phones or amounts (R-7); an unmapped event or a bad id is permanent', () => {
    const all = [
      ...mapUserEvent(envelope('order.placed', { orderId: ORDER }), two),
      ...mapUserEvent(envelope('seller_order.accepted', { sellerOrderId: SO_A }), two),
    ];
    for (const draft of all) expect(`${draft.title} ${draft.body}`).not.toMatch(/\d+\.\d{2}|\+20|EGP/);
    expect(() => mapUserEvent(envelope('something.else'), one)).toThrow(PermanentEventError);
    expect(() =>
      mapUserEvent(envelope('shipment.assigned', { shipmentId: 'x', agentId: AGENT }), undefined),
    ).toThrow(PermanentEventError);
  });
});
