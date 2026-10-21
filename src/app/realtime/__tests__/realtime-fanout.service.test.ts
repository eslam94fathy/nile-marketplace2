import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type EventEnvelope, PermanentEventError } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { type IRealtimeEmitter, type RealtimeMessage } from '../../../lib/realtime';
import { type IOrderingDirectory, type NotificationParty } from '../../ordering';
import { type ISupportDirectory, type TicketState } from '../../support';
import { RealtimeFanoutService } from '../service/realtime-fanout.service';

const ORDER = randomUUID();
const SO_A = randomUUID();
const SO_B = randomUUID();
const CUSTOMER = randomUUID();
const SELLER_A = randomUUID();
const SELLER_B = randomUUID();
const AGENT = randomUUID();
const PREVIOUS_AGENT = randomUUID();
const SHIPMENT = randomUUID();
const USER = randomUUID();
const MEDIA = randomUUID();
const TICKET = randomUUID();
const MESSAGE = randomUUID();
const OPENER = randomUUID();
const ADMIN = randomUUID();

const party = (overrides: Partial<NotificationParty> = {}): NotificationParty => ({
  orderId: ORDER,
  orderNumber: 'NM-000000123',
  customerId: CUSTOMER,
  status: 'placed',
  sellerOrders: [
    { sellerOrderId: SO_A, sellerId: SELLER_A, status: 'placed' },
    { sellerOrderId: SO_B, sellerId: SELLER_B, status: 'accepted' },
  ],
  ...overrides,
});

const envelope = (eventType: string, payload: Record<string, unknown>): EventEnvelope => ({
  eventId: randomUUID(),
  eventType,
  version: 1,
  occurredAt: '2026-10-20T10:00:00.000Z',
  correlationId: null,
  aggregateType: 'x',
  aggregateId: randomUUID(),
  payload,
});

function setup(
  parties: NotificationParty[] = [party()],
  tickets: Map<string, TicketState> = new Map([
    [TICKET, { status: 'awaiting_user', openerUserId: OPENER, assignedAdminUserId: ADMIN }],
  ]),
) {
  const sent: { rooms: readonly string[]; message: RealtimeMessage }[] = [];
  const disconnectUser = vi.fn();
  const emitter: IRealtimeEmitter = {
    toRooms: (rooms, message) => sent.push({ rooms, message }),
    disconnectUser,
  };
  const getNotificationParties = vi.fn((_ids: object) => Promise.resolve(parties));
  const ordering = { getNotificationParties } as unknown as IOrderingDirectory;
  const getTicketStates = vi.fn((_ids: readonly string[]) => Promise.resolve(tickets));
  const support = { getTicketStates } as unknown as ISupportDirectory;
  const warn = vi.fn();
  const logger = { warn } as unknown as ILogger;
  const service = new RealtimeFanoutService(ordering, support, emitter, logger);
  /** [type, rooms, data] per emit, for compact assertions. */
  const emits = () => sent.map(({ rooms, message }) => [message.type, [...rooms], message.data]);
  return { service, sent, emits, disconnectUser, getNotificationParties, getTicketStates, warn };
}

describe('RealtimeFanoutService (spec 15 UC-RT-2, §3.1)', () => {
  it('order.placed: order.updated to the customer, seller_order.placed to each live seller order', async () => {
    const { service, emits, sent } = setup([
      party({
        sellerOrders: [
          { sellerOrderId: SO_A, sellerId: SELLER_A, status: 'placed' },
          { sellerOrderId: SO_B, sellerId: SELLER_B, status: 'pending_payment' },
        ],
      }),
    ]);
    const event = envelope('order.placed', { orderId: ORDER });
    await service.handle(event);
    expect(emits()).toEqual([
      [
        'order.updated',
        [`customer:${CUSTOMER}`],
        { orderId: ORDER, orderNumber: 'NM-000000123', status: 'placed' },
      ],
      ['seller_order.placed', [`seller:${SELLER_A}`], { sellerOrderId: SO_A, orderNumber: 'NM-000000123' }],
    ]);
    // The envelope carries the source event's id and time (conventions §9.3).
    expect(sent[0]?.message).toMatchObject({ eventId: event.eventId, occurredAt: event.occurredAt });
  });

  it('payment.*: order.updated with the re-read status and payment.updated with the event status', async () => {
    for (const [eventType, paymentStatus] of [
      ['payment.paid', 'paid'],
      ['payment.failed', 'failed'],
      ['payment.expired', 'expired'],
    ] as const) {
      const { service, emits } = setup([party({ status: 'cancelled' })]);
      await service.handle(envelope(eventType, { orderId: ORDER }));
      expect(emits()).toEqual([
        [
          'order.updated',
          [`customer:${CUSTOMER}`],
          { orderId: ORDER, orderNumber: 'NM-000000123', status: 'cancelled' },
        ],
        ['payment.updated', [`customer:${CUSTOMER}`], { orderId: ORDER, paymentStatus }],
      ]);
    }
  });

  it('seller_order.* events: seller_order.updated with the current status to the customer and that seller', async () => {
    for (const eventType of [
      'seller_order.accepted',
      'seller_order.ready_for_pickup',
      'seller_order.items_cancelled',
      'seller_order.cancelled',
      'seller_order.returned',
      'seller_order.delivered',
    ]) {
      const { service, emits, getNotificationParties } = setup();
      await service.handle(envelope(eventType, { sellerOrderId: SO_B, orderId: ORDER }));
      expect(getNotificationParties).toHaveBeenCalledWith({ sellerOrderIds: [SO_B] });
      expect(emits()).toEqual([
        [
          'seller_order.updated',
          [`customer:${CUSTOMER}`, `seller:${SELLER_B}`],
          { sellerOrderId: SO_B, orderId: ORDER, status: 'accepted' },
        ],
      ]);
    }
  });

  it('shipment progress: shipment.updated to the customer and the agent, status from the event', async () => {
    const cases = [
      ['shipment.picked_up', {}, 'picked_up'],
      ['shipment.out_for_delivery', {}, 'out_for_delivery'],
      ['shipment.delivered', {}, 'delivered'],
      ['shipment.attempt_failed', { returningToSeller: false }, 'delivery_failed'],
      ['shipment.attempt_failed', { returningToSeller: true }, 'returning_to_seller'],
    ] as const;
    for (const [eventType, extra, status] of cases) {
      const { service, emits } = setup();
      await service.handle(
        envelope(eventType, {
          shipmentId: SHIPMENT,
          sellerOrderId: SO_A,
          orderId: ORDER,
          agentId: AGENT,
          ...extra,
        }),
      );
      expect(emits()).toEqual([
        [
          'shipment.updated',
          [`customer:${CUSTOMER}`, `agent:${AGENT}`],
          { shipmentId: SHIPMENT, sellerOrderId: SO_A, orderId: ORDER, status },
        ],
      ]);
    }
  });

  it('shipment.assigned: the new agent; shipment.unassigned to a replaced one; no reads', async () => {
    const { service, emits, getNotificationParties } = setup();
    const data = { shipmentId: SHIPMENT, sellerOrderId: SO_A };
    await service.handle(
      envelope('shipment.assigned', { ...data, agentId: AGENT, previousAgentId: PREVIOUS_AGENT }),
    );
    await service.handle(envelope('shipment.assigned', { ...data, agentId: AGENT, previousAgentId: null }));
    expect(emits()).toEqual([
      ['shipment.assigned', [`agent:${AGENT}`], data],
      ['shipment.unassigned', [`agent:${PREVIOUS_AGENT}`], data],
      ['shipment.assigned', [`agent:${AGENT}`], data],
    ]);
    expect(getNotificationParties).not.toHaveBeenCalled();
  });

  it('media.ready / media.failed: media.updated to the uploader', async () => {
    const { service, emits } = setup();
    await service.handle(envelope('media.ready', { mediaId: MEDIA, ownerUserId: USER }));
    await service.handle(envelope('media.failed', { mediaId: MEDIA, ownerUserId: USER }));
    expect(emits()).toEqual([
      ['media.updated', [`user:${USER}`], { mediaId: MEDIA, status: 'ready' }],
      ['media.updated', [`user:${USER}`], { mediaId: MEDIA, status: 'failed' }],
    ]);
  });

  it('user.suspended: disconnects every socket of the user (UC-RT-3)', async () => {
    const { service, disconnectUser } = setup();
    await service.handle(envelope('user.suspended', { userId: USER, role: 'customer', suspendedAt: 'x' }));
    expect(disconnectUser).toHaveBeenCalledWith(USER, 'account_suspended');
  });

  describe('support (spec 16, spec 15 §3.1)', () => {
    const message = (kind: string, senderRole: string) =>
      envelope('support.message_created', {
        ticketId: TICKET,
        ticketNumber: 'T-000000001',
        messageId: MESSAGE,
        kind,
        senderRole,
        openerUserId: OPENER,
        assignedAdminUserId: ADMIN,
      });

    it('support.message_created: the ticket room and the other side; notes to admins only; no reads', async () => {
      const { service, emits, getTicketStates } = setup();
      await service.handle(message('message', 'customer'));
      await service.handle(message('message', 'admin'));
      await service.handle(message('system', 'system'));
      await service.handle(message('internal_note', 'admin'));
      const data = { ticketId: TICKET, messageId: MESSAGE };
      expect(emits()).toEqual([
        ['support.message_created', [`ticket:${TICKET}`, 'admins'], data],
        ['support.message_created', [`ticket:${TICKET}`, `user:${OPENER}`], data],
        ['support.message_created', [`ticket:${TICKET}`, `user:${OPENER}`], data],
        ['support.message_created', ['admins'], data],
      ]);
      expect(getTicketStates).not.toHaveBeenCalled();
    });

    it('support.ticket_*: support.ticket_updated with the re-read status and assignee (SU-19)', async () => {
      const { service, emits } = setup();
      for (const [type, payload] of [
        ['support.ticket_opened', { ticketId: TICKET, ticketNumber: 'T-000000001', openerUserId: OPENER }],
        ['support.ticket_assigned', { ticketId: TICKET, openerUserId: OPENER, assignedAdminUserId: ADMIN }],
        ['support.ticket_status_changed', { ticketId: TICKET, from: 'open', to: 'awaiting_user' }],
      ] as const) {
        await service.handle(envelope(type, payload));
      }
      const update = [
        'support.ticket_updated',
        [`ticket:${TICKET}`, `user:${OPENER}`, 'admins'],
        { ticketId: TICKET, status: 'awaiting_user', assignedAdminId: ADMIN },
      ];
      expect(emits()).toEqual([update, update, update]);
    });

    it('a ticket the re-read cannot find: nothing sent, a warn; a bad id is permanent', async () => {
      const { service, emits, warn } = setup([party()], new Map());
      await service.handle(envelope('support.ticket_opened', { ticketId: TICKET }));
      expect(emits()).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
      await expect(
        service.handle(envelope('support.message_created', { ticketId: 'nope', kind: 'message' })),
      ).rejects.toBeInstanceOf(PermanentEventError);
    });
  });

  it('an order the re-read cannot find: nothing sent, a warn', async () => {
    const { service, emits, warn } = setup([]);
    await service.handle(envelope('order.closed', { orderId: ORDER }));
    expect(emits()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('a malformed payload or an unmapped event is permanent (DLQ); a failing read is retried', async () => {
    const { service } = setup();
    await expect(service.handle(envelope('order.placed', { orderId: 'nope' }))).rejects.toBeInstanceOf(
      PermanentEventError,
    );
    await expect(service.handle(envelope('something.else', {}))).rejects.toBeInstanceOf(PermanentEventError);
    const failing = setup();
    failing.getNotificationParties.mockRejectedValueOnce(new Error('db down'));
    await expect(
      failing.service.handle(envelope('order.closed', { orderId: ORDER })),
    ).rejects.not.toBeInstanceOf(PermanentEventError);
  });
});
