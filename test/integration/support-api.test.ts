import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { insertReadyMedia } from '../helpers/media';
import { orderingApi } from '../helpers/ordering-api';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';
const OPEN_TICKET_LIMIT = 3;

interface TicketSummary {
  id: string;
  ticketNumber: string;
  category: string;
  subject: string;
  status: string;
  order: { id: string; orderNumber: string } | null;
  sellerOrderId: string | null;
  lastMessageAt: string;
  hasUnread: boolean;
  createdAt: string;
}

interface TicketMessage {
  id: string;
  kind: string;
  sender: { role: string; isMe: boolean; displayName: string };
  body: string;
  attachments: { id: string; urls: Record<string, string> }[];
  createdAt: string;
}

/*
 * Spec 16 §4.1 (UC-SU-1, UC-SU-2 user side, UC-SU-4): customers and sellers on their own tickets,
 * against real Postgres, Redis and MinIO-less media rows (presigning is local).
 */
describe('support: customer and seller endpoints', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  const knex = () => t.infra.db.knex;

  const openTicket = (token: string, body: object, key: string | null = randomUUID()) =>
    api.as(token).post('/support/tickets', body, key);
  const ticketBody = (overrides: Record<string, unknown> = {}) => ({
    category: 'order',
    subject: 'Where is my parcel?',
    body: 'It has been a week.',
    ...overrides,
  });

  /** A customer with a COD order of one seller; returns the order and its seller order. */
  async function customerWithOrder() {
    const buyer = await api.customer();
    const variant = await api.listedVariant({ price: '100.00' });
    const { order } = await api.placeOrder(buyer, [{ variantId: variant.variantId, quantity: 1 }], '150.00');
    const sellerOrder = order.sellerOrders[0];
    if (!sellerOrder) throw new Error('fixture');
    return { buyer, variant, order, sellerOrderId: sellerOrder.id };
  }

  async function opened(token: string, overrides: Record<string, unknown> = {}): Promise<TicketSummary> {
    const res = await openTicket(token, ticketBody(overrides));
    expect(res.status).toBe(201);
    return successBody<TicketSummary>(res).data;
  }

  /** What an admin reply leaves behind (the admin endpoints come with step 4). */
  async function adminReplied(ticketId: string, at = new Date()) {
    const admin = await api.fx.insertUser('admin');
    await knex()('support_messages').insert({
      ticket_id: ticketId,
      kind: 'message',
      sender_user_id: admin,
      sender_role: 'admin',
      body: 'We are on it.',
    });
    await knex()('support_messages').insert({
      ticket_id: ticketId,
      kind: 'internal_note',
      sender_user_id: admin,
      sender_role: 'admin',
      body: 'Customer seems upset; check the courier.',
    });
    await knex()('support_tickets').where({ id: ticketId }).update({
      status: 'awaiting_user',
      awaiting_admin_since: null,
      last_admin_message_at: at,
      last_message_at: at,
      assigned_admin_user_id: admin,
    });
    return admin;
  }

  beforeAll(async () => {
    t = await startTestApp({
      envOverrides: { SUPPORT_MAX_OPEN_TICKETS_PER_USER: String(OPEN_TICKET_LIMIT) },
    });
    api = orderingApi(t);
    await api.init();
  });
  afterAll(async () => {
    await t.close();
  });

  describe('POST /support/tickets', () => {
    it('a customer opens a ticket about an order and one of its seller orders, with an image', async () => {
      const { buyer, order, sellerOrderId } = await customerWithOrder();
      const mediaId = await insertReadyMedia(t, buyer.userId, 'support_attachment');
      const res = await openTicket(
        buyer.token,
        ticketBody({ orderId: order.id, sellerOrderId, attachmentMediaIds: [mediaId] }),
      );

      expect(res.status).toBe(201);
      const ticket = successBody<TicketSummary>(res).data;
      expect(ticket).toMatchObject({
        category: 'order',
        subject: 'Where is my parcel?',
        status: 'open',
        order: { id: order.id, orderNumber: order.orderNumber },
        sellerOrderId,
        hasUnread: false,
      });
      expect(ticket.ticketNumber).toMatch(/^T-\d{9}$/);

      const [message] = await knex()('support_messages')
        .where({ ticket_id: ticket.id })
        .select<{ id: string; kind: string; sender_role: string }[]>('id', 'kind', 'sender_role');
      expect(message).toMatchObject({ kind: 'message', sender_role: 'customer' });
      expect(
        await knex()('support_message_attachments').where({ message_id: message?.id }).select('media_id'),
      ).toEqual([{ media_id: mediaId }]);
      const media = await knex()('media_objects')
        .where({ id: mediaId })
        .first<{ claimed_at: Date | null }>('claimed_at');
      expect(media?.claimed_at).not.toBeNull();
      expect(
        await knex()('support_ticket_reads').where({ ticket_id: ticket.id, user_id: buyer.userId }),
      ).toHaveLength(1);

      expect(await api.eventsOf('support.ticket_opened', ticket.id)).toEqual([
        {
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
          openerUserId: buyer.userId,
          openerRole: 'customer',
          category: 'order',
        },
      ]);
      expect(await api.eventsOf('support.message_created', ticket.id)).toEqual([
        {
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
          messageId: message?.id,
          kind: 'message',
          senderRole: 'customer',
          openerUserId: buyer.userId,
          assignedAdminUserId: null,
        },
      ]);
    });

    it('a seller links its seller order and gets the order number too (SU-10)', async () => {
      const { variant, order, sellerOrderId } = await customerWithOrder();
      const ticket = await opened(variant.sellerToken, { category: 'delivery', sellerOrderId });
      expect(ticket.order).toEqual({ id: order.id, orderNumber: order.orderNumber });
      expect(ticket.sellerOrderId).toBe(sellerOrderId);
    });

    it('a seller not yet approved may ask about onboarding (SU-9); a customer may not (422)', async () => {
      const pending = await api.fx.insertSeller('pending_approval');
      const sellerToken = await signTestAccessToken({ sub: pending.userId, role: 'seller' });
      expect((await opened(sellerToken, { category: 'seller_onboarding' })).status).toBe('open');

      const buyer = await api.customer();
      const res = await openTicket(buyer.token, ticketBody({ category: 'seller_onboarding' }));
      expect(res.status).toBe(422);
      expect(errorBody(res).error.code).toBe('SUPPORT_CATEGORY_NOT_ALLOWED');
    });

    it('400 for role-specific DTO rules, bad fields and a missing Idempotency-Key', async () => {
      const { buyer, variant, order, sellerOrderId } = await customerWithOrder();
      const cases: [string, object][] = [
        [variant.sellerToken, ticketBody({ orderId: order.id })], // sellers send a seller order only
        [buyer.token, ticketBody({ sellerOrderId })], // a seller order needs its order
        [buyer.token, ticketBody({ body: '   ' })],
        [buyer.token, ticketBody({ subject: 'ab' })],
        [buyer.token, ticketBody({ category: 'refund' })],
        [
          buyer.token,
          ticketBody({ attachmentMediaIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()] }),
        ],
        [buyer.token, ticketBody({ priority: 'high' })],
      ];
      for (const [token, body] of cases) {
        const res = await openTicket(token, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(errorBody(res).error.code).toBe('VALIDATION_FAILED');
      }
      const noKey = await openTicket(buyer.token, ticketBody(), null);
      expect(noKey.status).toBe(400);
      expect(await knex()('support_tickets').where({ opener_user_id: buyer.userId })).toHaveLength(0);
    });

    it('422 for a foreign or mismatched order link, and media that is not attachable', async () => {
      const mine = await customerWithOrder();
      const theirs = await customerWithOrder();
      const expectCode = async (token: string, body: Record<string, unknown>, code: string) => {
        const res = await openTicket(token, ticketBody(body));
        expect(res.status, code).toBe(422);
        expect(errorBody(res).error.code).toBe(code);
      };
      await expectCode(mine.buyer.token, { orderId: theirs.order.id }, 'ORDER_NOT_FOUND');
      await expectCode(mine.buyer.token, { orderId: UNKNOWN_ID }, 'ORDER_NOT_FOUND');
      await expectCode(
        mine.buyer.token,
        { orderId: mine.order.id, sellerOrderId: theirs.sellerOrderId },
        'SELLER_ORDER_NOT_FOUND',
      );
      await expectCode(
        mine.variant.sellerToken,
        { sellerOrderId: theirs.sellerOrderId },
        'SELLER_ORDER_NOT_FOUND',
      );

      const othersMedia = await insertReadyMedia(t, theirs.buyer.userId, 'support_attachment');
      const productImage = await insertReadyMedia(t, mine.buyer.userId, 'review_image');
      const res = await openTicket(
        mine.buyer.token,
        ticketBody({ attachmentMediaIds: [othersMedia, productImage] }),
      );
      expect(res.status).toBe(422);
      expect(errorBody(res).error.code).toBe('MEDIA_NOT_ATTACHABLE');
      expect(errorBody(res).error.details?.map((d) => d.constraint)).toEqual(['not_found', 'wrong_purpose']);
      // Rolled back: no ticket, nothing claimed.
      expect(await knex()('support_tickets').where({ opener_user_id: mine.buyer.userId })).toHaveLength(0);
    });

    it('the open-ticket limit counts unfinished tickets only (SU-4)', async () => {
      const buyer = await api.customer();
      const tickets = [];
      for (let i = 0; i < OPEN_TICKET_LIMIT; i += 1) tickets.push(await opened(buyer.token));
      const over = await openTicket(buyer.token, ticketBody());
      expect(over.status).toBe(422);
      expect(errorBody(over).error.code).toBe('SUPPORT_OPEN_TICKET_LIMIT_REACHED');

      await knex()('support_tickets')
        .where({ id: tickets[0]?.id })
        .update({ status: 'resolved', awaiting_admin_since: null, resolved_at: new Date() });
      expect((await openTicket(buyer.token, ticketBody())).status).toBe(201);
    });

    it('replays a retried open with the same Idempotency-Key: one ticket (SU-1)', async () => {
      const buyer = await api.customer();
      const key = randomUUID();
      const first = await openTicket(buyer.token, ticketBody(), key);
      const second = await openTicket(buyer.token, ticketBody(), key);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(await knex()('support_tickets').where({ opener_user_id: buyer.userId })).toHaveLength(1);
    });

    it('401 without a token, 403 for admins and delivery agents', async () => {
      expect((await request(t.app).post(`${API}/support/tickets`).send(ticketBody())).status).toBe(401);
      for (const role of ['admin', 'delivery_agent'] as const) {
        const token = await signTestAccessToken({ sub: randomUUID(), role });
        const res = await openTicket(token, ticketBody());
        expect(res.status, role).toBe(403);
      }
    });
  });

  describe('reading tickets and timelines', () => {
    it('lists my tickets only, latest activity first, with filters and pages', async () => {
      const buyer = await api.customer();
      const other = await api.customer();
      const a = await opened(buyer.token, { category: 'payment' });
      const b = await opened(buyer.token, { category: 'account' });
      await opened(other.token);
      await adminReplied(a.id);

      const all = await api.as(buyer.token).get('/support/tickets');
      expect(all.status).toBe(200);
      expect(successBody<TicketSummary[]>(all).data.map((x) => x.id)).toEqual([a.id, b.id]);

      const waiting = await api
        .as(buyer.token)
        .get('/support/tickets?status[in]=awaiting_user,awaiting_admin');
      expect(successBody<TicketSummary[]>(waiting).data.map((x) => x.id)).toEqual([a.id]);
      const account = await api.as(buyer.token).get('/support/tickets?category[eq]=account&sort=createdAt');
      expect(successBody<TicketSummary[]>(account).data.map((x) => x.id)).toEqual([b.id]);

      const first = await api.as(buyer.token).get('/support/tickets?limit=1');
      const meta = successBody<TicketSummary[]>(first).meta;
      expect(meta).toMatchObject({ hasMore: true, limit: 1 });
      const next = await api.as(buyer.token).get(`/support/tickets?limit=1&cursor=${meta?.nextCursor ?? ''}`);
      expect(successBody<TicketSummary[]>(next).data.map((x) => x.id)).toEqual([b.id]);

      expect((await api.as(buyer.token).get('/support/tickets?assigned[eq]=true')).status).toBe(400);
    });

    it('unread after an admin reply until the opener reads it; reading again is harmless', async () => {
      const buyer = await api.customer();
      const ticket = await opened(buyer.token);
      await adminReplied(ticket.id, new Date(Date.now() + 1_000));
      const hasUnread = async () =>
        successBody<TicketSummary>(await api.as(buyer.token).get(`/support/tickets/${ticket.id}`)).data
          .hasUnread;

      expect(await hasUnread()).toBe(true);
      // The reply is stamped a second ahead: a read now is still older (GREATEST keeps the newest).
      expect((await api.as(buyer.token).post(`/support/tickets/${ticket.id}/read`)).status).toBe(204);
      expect(await hasUnread()).toBe(true);
      await knex()('support_ticket_reads')
        .where({ ticket_id: ticket.id, user_id: buyer.userId })
        .update({ last_read_at: new Date(Date.now() + 2_000) });
      expect(await hasUnread()).toBe(false);
      expect((await api.as(buyer.token).post(`/support/tickets/${ticket.id}/read`)).status).toBe(204);
      expect(await hasUnread()).toBe(false);
    });

    it('the timeline hides internal notes, names the opener, shows admins as Nile Support (SU-3)', async () => {
      const buyer = await api.customer();
      const mediaId = await insertReadyMedia(t, buyer.userId, 'support_attachment');
      const ticket = await opened(buyer.token, { attachmentMediaIds: [mediaId] });
      await adminReplied(ticket.id);

      const res = await api.as(buyer.token).get(`/support/tickets/${ticket.id}/messages`);
      expect(res.status).toBe(200);
      const messages = successBody<TicketMessage[]>(res).data;
      expect(messages.map((m) => [m.kind, m.sender])).toEqual([
        ['message', { role: 'admin', isMe: false, displayName: 'Nile Support' }],
        ['message', { role: 'customer', isMe: true, displayName: 'Mona Ali' }],
      ]);
      const [image] = messages[1]?.attachments ?? [];
      expect(image?.id).toBe(mediaId);
      // Private: presigned GETs of the private prefix (ME-1).
      expect(image?.urls.large).toContain(`private/${mediaId}/large.webp`);
      expect(image?.urls.large).toMatch(/X-Amz-Signature=/);
    });

    it("404 for another user's ticket or an unknown one, on every route", async () => {
      const owner = await api.customer();
      const stranger = await api.customer();
      const ticket = await opened(owner.token);
      for (const id of [ticket.id, UNKNOWN_ID]) {
        const as = api.as(stranger.token);
        for (const res of [
          await as.get(`/support/tickets/${id}`),
          await as.get(`/support/tickets/${id}/messages`),
          await as.post(`/support/tickets/${id}/messages`, { body: 'Hello?' }),
          await as.post(`/support/tickets/${id}/read`),
        ]) {
          expect(res.status).toBe(404);
          expect(errorBody(res).error.code).toBe('SUPPORT_TICKET_NOT_FOUND');
        }
      }
      expect((await api.as(stranger.token).get('/support/tickets/not-a-uuid')).status).toBe(400);
    });
  });

  describe('POST /support/tickets/:ticketId/messages', () => {
    it('on open keeps it open; after an admin reply it waits for an admin again', async () => {
      const buyer = await api.customer();
      const ticket = await opened(buyer.token);
      const post = (body: string) =>
        api.as(buyer.token).post(`/support/tickets/${ticket.id}/messages`, { body });

      const first = await post('Any news?');
      expect(first.status).toBe(201);
      expect(successBody<TicketMessage>(first).data).toMatchObject({
        kind: 'message',
        body: 'Any news?',
        sender: { role: 'customer', isMe: true, displayName: 'Mona Ali' },
        attachments: [],
      });
      const status = async () =>
        (await knex()('support_tickets').where({ id: ticket.id }).first<{ status: string }>('status'))
          ?.status;
      expect(await status()).toBe('open');
      expect(await api.eventsOf('support.ticket_status_changed', ticket.id)).toEqual([]);

      await adminReplied(ticket.id);
      await knex()('support_tickets').where({ id: ticket.id }).update({ sla_breached_at: new Date() });
      expect((await post('Thanks, but it is still missing.')).status).toBe(201);
      const row = await knex()('support_tickets')
        .where({ id: ticket.id })
        .first<{ status: string; awaiting_admin_since: Date | null; sla_breached_at: Date | null }>(
          'status',
          'awaiting_admin_since',
          'sla_breached_at',
        );
      expect(row).toMatchObject({ status: 'awaiting_admin', sla_breached_at: null });
      expect(row?.awaiting_admin_since).not.toBeNull();
      expect(await api.eventsOf('support.ticket_status_changed', ticket.id)).toEqual([
        {
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
          openerUserId: buyer.userId,
          from: 'awaiting_user',
          to: 'awaiting_admin',
          actor: 'customer',
        },
      ]);
    });

    it('reopens a resolved ticket with a system line (SU-12); a closed one is 409', async () => {
      const buyer = await api.customer();
      const ticket = await opened(buyer.token);
      await knex()('support_tickets')
        .where({ id: ticket.id })
        .update({ status: 'resolved', awaiting_admin_since: null, resolved_at: new Date() });
      const res = await api
        .as(buyer.token)
        .post(`/support/tickets/${ticket.id}/messages`, { body: 'Not fixed.' });
      expect(res.status).toBe(201);
      const row = await knex()('support_tickets')
        .where({ id: ticket.id })
        .first<{ status: string; resolved_at: Date | null }>('status', 'resolved_at');
      expect(row).toEqual({ status: 'awaiting_admin', resolved_at: null });

      const timeline = successBody<TicketMessage[]>(
        await api.as(buyer.token).get(`/support/tickets/${ticket.id}/messages`),
      ).data;
      expect(timeline[0]).toMatchObject({
        kind: 'system',
        body: 'Ticket reopened',
        sender: { role: 'system', isMe: false, displayName: 'Nile Support' },
      });

      await knex()('support_tickets')
        .where({ id: ticket.id })
        .update({ status: 'closed', awaiting_admin_since: null, closed_at: new Date() });
      const closed = await api
        .as(buyer.token)
        .post(`/support/tickets/${ticket.id}/messages`, { body: 'Hello?' });
      expect(closed.status).toBe(409);
      expect(errorBody(closed).error.code).toBe('SUPPORT_TICKET_CLOSED');
    });

    it('replays a retried message with the same Idempotency-Key: one message (SU-1)', async () => {
      const buyer = await api.customer();
      const ticket = await opened(buyer.token);
      const key = randomUUID();
      const send = () =>
        api.as(buyer.token).post(`/support/tickets/${ticket.id}/messages`, { body: 'Once' }, key);
      const first = await send();
      const second = await send();
      expect(first.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(await knex()('support_messages').where({ ticket_id: ticket.id, body: 'Once' })).toHaveLength(1);
    });

    it('400 for a bad body or too many images; 422 for media already attached', async () => {
      const buyer = await api.customer();
      const mediaId = await insertReadyMedia(t, buyer.userId, 'support_attachment');
      const ticket = await opened(buyer.token, { attachmentMediaIds: [mediaId] });
      const post = (body: object) => api.as(buyer.token).post(`/support/tickets/${ticket.id}/messages`, body);
      expect((await post({ body: '' })).status).toBe(400);
      expect((await post({ body: 'x'.repeat(4001) })).status).toBe(400);
      expect((await post({ body: 'Hi', internal: true })).status).toBe(400);
      const reused = await post({ body: 'Again', attachmentMediaIds: [mediaId] });
      expect(reused.status).toBe(422);
      expect(errorBody(reused).error.details?.[0]?.constraint).toBe('already_claimed');
    });
  });
});
