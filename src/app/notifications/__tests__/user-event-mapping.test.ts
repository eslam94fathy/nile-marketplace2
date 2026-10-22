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

  describe('support (spec 13 §8.2, NO-31)', () => {
    const TICKET = randomUUID();
    const OPENER = randomUUID();
    const ADMIN = randomUUID();
    const message = (payload: Record<string, unknown>) =>
      envelope('support.message_created', {
        ticketId: TICKET,
        ticketNumber: 'T-000000042',
        messageId: randomUUID(),
        kind: 'message',
        senderRole: 'admin',
        openerUserId: OPENER,
        assignedAdminUserId: ADMIN,
        ...payload,
      });

    it('a public admin reply notifies the opener; a user message the assigned admin', () => {
      expect(rows(mapUserEvent(message({}), undefined))).toEqual([
        [
          `user:${OPENER}`,
          'support_reply',
          'support',
          'New reply',
          'Support replied on T-000000042.',
          `/support/tickets/${TICKET}`,
        ],
      ]);
      expect(rows(mapUserEvent(message({ senderRole: 'seller' }), undefined))).toEqual([
        [
          `user:${ADMIN}`,
          'support_user_message',
          'support',
          'New message',
          'T-000000042 has a new message.',
          `/admin/support/tickets/${TICKET}`,
        ],
      ]);
    });

    it('nobody for notes, system lines, or a user message on an unassigned ticket (NO-9)', () => {
      expect(mapUserEvent(message({ kind: 'internal_note' }), undefined)).toEqual([]);
      expect(mapUserEvent(message({ kind: 'system', senderRole: 'system' }), undefined)).toEqual([]);
      expect(mapUserEvent(message({ senderRole: 'customer', assignedAdminUserId: null }), undefined)).toEqual(
        [],
      );
    });

    it('resolved notifies the opener; other status changes nobody', () => {
      const changed = (to: string) =>
        envelope('support.ticket_status_changed', {
          ticketId: TICKET,
          ticketNumber: 'T-000000042',
          openerUserId: OPENER,
          from: 'awaiting_user',
          to,
          actor: 'admin',
        });
      expect(rows(mapUserEvent(changed('resolved'), undefined))).toEqual([
        [
          `user:${OPENER}`,
          'support_resolved',
          'support',
          'Ticket resolved',
          'T-000000042 was marked resolved.',
          `/support/tickets/${TICKET}`,
        ],
      ]);
      expect(mapUserEvent(changed('closed'), undefined)).toEqual([]);
    });

    it('a malformed ticket number is permanent', () => {
      expect(() => mapUserEvent(message({ ticketNumber: 'X-1' }), undefined)).toThrow(PermanentEventError);
    });
  });

  describe('reviews (spec 13 §8.8, NO-32)', () => {
    const REVIEW = randomUUID();

    it('review.created notifies the seller; review.replied the reviewer; no product names', () => {
      expect(
        rows(
          mapUserEvent(
            envelope('review.created', {
              reviewId: REVIEW,
              productId: randomUUID(),
              sellerId: SELLER_A,
              customerId: CUSTOMER,
              rating: 2,
            }),
            undefined,
          ),
        ),
      ).toEqual([
        [
          `seller:${SELLER_A}`,
          'review_received',
          'orders',
          'New review',
          'One of your products has a new review.',
          '/seller/reviews',
        ],
      ]);
      expect(
        rows(
          mapUserEvent(
            envelope('review.replied', { reviewId: REVIEW, productId: randomUUID(), customerId: CUSTOMER }),
            undefined,
          ),
        ),
      ).toEqual([
        [
          `customer:${CUSTOMER}`,
          'review_replied',
          'orders',
          'Seller replied',
          'The seller replied to your review.',
          `/me/reviews/${REVIEW}`,
        ],
      ]);
    });

    it('a malformed recipient is permanent', () => {
      expect(() => mapUserEvent(envelope('review.created', { sellerId: 'x' }), undefined)).toThrow(
        PermanentEventError,
      );
    });
  });

  describe('returns and refunds (spec 13 §8.9, NO-34)', () => {
    const RETURN = randomUUID();
    const changed = (to: string, overrides: Record<string, unknown> = {}) =>
      envelope('return.status_changed', {
        returnId: RETURN,
        returnNumber: 'R-000000042',
        orderId: ORDER,
        orderNumber: N,
        sellerOrderId: SO_A,
        customerId: CUSTOMER,
        sellerId: SELLER_A,
        from: null,
        to,
        actor: 'customer',
        ...overrides,
      });
    const customer = `customer:${CUSTOMER}`;
    const seller = `seller:${SELLER_A}`;
    const mine = `/returns/${RETURN}`;
    const theirs = `/seller/returns/${RETURN}`;

    it('each listed status notifies its side, linked to the return; the others nobody', () => {
      const map = (to: string) => rows(mapUserEvent(changed(to), undefined));
      expect(map('requested')).toEqual([
        [
          seller,
          'return_requested',
          'orders',
          'Return requested',
          `A return was requested on order #${N}.`,
          theirs,
        ],
      ]);
      expect(map('approved')).toEqual([
        [
          customer,
          'return_approved',
          'orders',
          'Return approved',
          'Your return R-000000042 was approved. An agent will pick it up.',
          mine,
        ],
      ]);
      expect(map('rejected')).toEqual([
        [
          customer,
          'return_rejected',
          'orders',
          'Return rejected',
          'Your return R-000000042 was rejected. You can escalate it.',
          mine,
        ],
      ]);
      expect(map('picked_up')).toEqual([
        [
          customer,
          'return_picked_up',
          'orders',
          'Return picked up',
          'Your return R-000000042 is on its way to the seller.',
          mine,
        ],
      ]);
      expect(map('received')).toEqual([
        [
          seller,
          'return_received',
          'orders',
          'Return arrived',
          'Return R-000000042 was delivered to you. Please inspect it.',
          theirs,
        ],
      ]);
      expect(map('completed')).toEqual([
        [
          customer,
          'return_completed',
          'orders',
          'Return accepted',
          'Return R-000000042 is complete. Your refund is on its way.',
          mine,
        ],
      ]);
      const closed = 'Return R-000000042 was closed without a refund.';
      expect(map('refused')).toEqual([
        [customer, 'return_refused', 'orders', 'Return closed', closed, mine],
        [seller, 'return_refused', 'orders', 'Return closed', closed, theirs],
      ]);
      for (const to of ['escalated', 'disputed', 'cancelled', 'pickup_failed']) expect(map(to)).toEqual([]);
    });

    it('a malformed return number, order number or profile is permanent', () => {
      expect(() => mapUserEvent(changed('approved', { returnNumber: 'R-1' }), undefined)).toThrow(
        PermanentEventError,
      );
      expect(() => mapUserEvent(changed('requested', { orderNumber: 'x' }), undefined)).toThrow(
        PermanentEventError,
      );
      expect(() => mapUserEvent(changed('approved', { customerId: 'x' }), undefined)).toThrow(
        PermanentEventError,
      );
    });

    it('refund_issued to the customer for every reason, linked to the order', () => {
      for (const eventType of ['payment.refunded', 'payment.refund_recorded']) {
        for (const reason of ['return', 'seller_order_cancelled']) {
          expect(rows(mapUserEvent(envelope(eventType, { orderId: ORDER, reason }), one))).toEqual([
            [
              customer,
              'refund_issued',
              'orders',
              'Refund issued',
              `Your refund for order #${N} was issued.`,
              `/orders/${ORDER}`,
            ],
          ]);
        }
      }
    });
  });
});
