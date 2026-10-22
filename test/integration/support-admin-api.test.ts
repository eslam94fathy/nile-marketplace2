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

interface AdminTicket {
  id: string;
  ticketNumber: string;
  status: string;
  hasUnread: boolean;
  opener: { userId: string; role: string; displayName: string; email: string };
  assignedAdmin: { userId: string; displayName: string } | null;
  slaBreachedAt: string | null;
  awaitingAdminSince: string | null;
}

interface TicketMessage {
  id: string;
  kind: string;
  sender: { role: string; isMe: boolean; displayName: string };
  body: string;
  attachments: { id: string }[];
}

interface Admin {
  userId: string;
  email: string;
  token: string;
}

/*
 * Spec 16 §4.2 (UC-SU-2 admin side, UC-SU-3, UC-SU-4): the admin queue, replies and notes,
 * assignment, resolve and close, with audit rows (SU-5, SU-18), on real Postgres and Redis.
 */
describe('support: admin endpoints', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  const knex = () => t.infra.db.knex;

  async function admin(status = 'active'): Promise<Admin> {
    const userId = await api.fx.insertUser('admin');
    await knex()('users').where({ id: userId }).update({ status });
    const row = await knex()('users').where({ id: userId }).first<{ email: string }>('email');
    return {
      userId,
      email: row?.email ?? '',
      token: await signTestAccessToken({ sub: userId, role: 'admin' }),
    };
  }

  /** A fresh customer and a ticket they opened through the API. */
  async function openedTicket(subject = 'Where is my parcel?') {
    const buyer = await api.customer();
    const res = await api
      .as(buyer.token)
      .post('/support/tickets', { category: 'order', subject, body: 'It has been a week.' });
    expect(res.status).toBe(201);
    return { buyer, ticketId: successBody<{ id: string }>(res).data.id };
  }

  const asAdmin = (who: Admin) => api.as(who.token);
  const reply = (who: Admin, ticketId: string, body: object, key?: string) =>
    asAdmin(who).post(`/admin/support/tickets/${ticketId}/messages`, body, key);
  const ticketRow = (id: string) =>
    knex()('support_tickets').where({ id }).first<{
      status: string;
      assigned_admin_user_id: string | null;
      awaiting_admin_since: Date | null;
      resolved_at: Date | null;
      closed_at: Date | null;
    }>('status', 'assigned_admin_user_id', 'awaiting_admin_since', 'resolved_at', 'closed_at');
  const auditRows = (ticketId: string) =>
    knex()('admin_audit_log')
      .where({ target_type: 'support_ticket', target_id: ticketId })
      .orderBy('id')
      .select<{ action: string; actor_user_id: string; changes: unknown }[]>(
        'action',
        'actor_user_id',
        'changes',
      );
  const timeline = async (who: Admin, ticketId: string) =>
    successBody<TicketMessage[]>(await asAdmin(who).get(`/admin/support/tickets/${ticketId}/messages`)).data;
  const listIds = async (who: Admin, query: string) => {
    const res = await asAdmin(who).get(`/admin/support/tickets?limit=100${query}`);
    expect(res.status, query).toBe(200);
    return successBody<AdminTicket[]>(res).data.map((ticket) => ticket.id);
  };

  beforeAll(async () => {
    t = await startTestApp();
    api = orderingApi(t);
    await api.init();
  });
  afterAll(async () => {
    await t.close();
  });

  describe('replies and notes', () => {
    it('the first reply assigns the ticket to its sender, with a system line, an event and an audit row (SU-2, SU-18)', async () => {
      const support = await admin();
      const { buyer, ticketId } = await openedTicket();
      const res = await reply(support, ticketId, { body: 'We are on it.' });
      expect(res.status).toBe(201);
      expect(successBody<TicketMessage>(res).data).toMatchObject({
        kind: 'message',
        sender: { role: 'admin', isMe: true, displayName: support.email },
      });
      expect(await ticketRow(ticketId)).toMatchObject({
        status: 'awaiting_user',
        assigned_admin_user_id: support.userId,
        awaiting_admin_since: null,
      });
      expect((await timeline(support, ticketId)).map((m) => [m.kind, m.body])).toEqual([
        ['system', 'Ticket assigned to a support agent'],
        ['message', 'We are on it.'],
        ['message', 'It has been a week.'],
      ]);
      expect(await api.eventsOf('support.ticket_assigned', ticketId)).toEqual([
        {
          ticketId,
          openerUserId: buyer.userId,
          assignedAdminUserId: support.userId,
          previousAdminUserId: null,
        },
      ]);
      expect(await api.eventsOf('support.ticket_status_changed', ticketId)).toEqual([
        expect.objectContaining({ from: 'open', to: 'awaiting_user', actor: 'admin' }),
      ]);
      expect(await auditRows(ticketId)).toEqual([
        {
          action: 'support_ticket.assigned',
          actor_user_id: support.userId,
          changes: { before: { assignedAdminUserId: null }, after: { assignedAdminUserId: support.userId } },
        },
      ]);

      // A later reply by another admin doesn't take the ticket over.
      const other = await admin();
      expect((await reply(other, ticketId, { body: 'Adding a detail.' })).status).toBe(201);
      expect((await ticketRow(ticketId))?.assigned_admin_user_id).toBe(support.userId);
    });

    it('two admins replying at once: one assignee, one assignment event', async () => {
      const [first, second] = [await admin(), await admin()];
      const { ticketId } = await openedTicket();
      const results = await Promise.all([
        reply(first, ticketId, { body: 'Mine.' }),
        reply(second, ticketId, { body: 'No, mine.' }),
      ]);
      expect(results.map((res) => res.status)).toEqual([201, 201]);
      const assignee = (await ticketRow(ticketId))?.assigned_admin_user_id;
      expect([first.userId, second.userId]).toContain(assignee);
      expect(await api.eventsOf('support.ticket_assigned', ticketId)).toHaveLength(1);
      expect((await auditRows(ticketId)).map((row) => row.action)).toEqual(['support_ticket.assigned']);
    });

    it('an internal note changes nothing and never reaches the user; it is allowed on a closed ticket', async () => {
      const support = await admin();
      const { buyer, ticketId } = await openedTicket();
      const mediaId = await insertReadyMedia(t, support.userId, 'support_attachment');
      const note = await reply(support, ticketId, {
        body: 'Courier says delivered.',
        internal: true,
        attachmentMediaIds: [mediaId],
      });
      expect(note.status).toBe(201);
      expect(successBody<TicketMessage>(note).data).toMatchObject({ kind: 'internal_note' });
      expect(await ticketRow(ticketId)).toMatchObject({ status: 'open', assigned_admin_user_id: null });

      const userView = successBody<TicketMessage[]>(
        await api.as(buyer.token).get(`/support/tickets/${ticketId}/messages`),
      ).data;
      expect(userView.map((m) => m.kind)).toEqual(['message']);
      const adminView = await timeline(support, ticketId);
      expect(adminView[0]).toMatchObject({ kind: 'internal_note', attachments: [{ id: mediaId }] });

      expect((await asAdmin(support).post(`/admin/support/tickets/${ticketId}/close`)).status).toBe(200);
      expect((await reply(support, ticketId, { body: 'For the record.', internal: true })).status).toBe(201);
      const closed = await reply(support, ticketId, { body: 'Hello again.' });
      expect(closed.status).toBe(409);
      expect(errorBody(closed).error.code).toBe('SUPPORT_TICKET_CLOSED');
    });

    it('a reply reopens a resolved ticket into awaiting_user', async () => {
      const support = await admin();
      const { ticketId } = await openedTicket();
      expect((await asAdmin(support).post(`/admin/support/tickets/${ticketId}/resolve`)).status).toBe(200);
      expect((await reply(support, ticketId, { body: 'One more thing.' })).status).toBe(201);
      expect(await ticketRow(ticketId)).toMatchObject({ status: 'awaiting_user', resolved_at: null });
    });

    it('replays a retried reply with the same Idempotency-Key; 400 for a bad body', async () => {
      const support = await admin();
      const { ticketId } = await openedTicket();
      const key = randomUUID();
      const first = await reply(support, ticketId, { body: 'Once' }, key);
      const second = await reply(support, ticketId, { body: 'Once' }, key);
      expect(second.body).toEqual(first.body);
      expect(await knex()('support_messages').where({ ticket_id: ticketId, body: 'Once' })).toHaveLength(1);
      expect((await reply(support, ticketId, { body: 'Hi', internal: 'yes' })).status).toBe(400);
      expect((await reply(support, ticketId, { body: '' })).status).toBe(400);
    });
  });

  describe('assign, resolve, close', () => {
    it('assigns to another active admin, unassigns with null, and the same assignee writes nothing (SU-13)', async () => {
      const [support, colleague] = [await admin(), await admin()];
      const { ticketId } = await openedTicket();
      const assign = (adminUserId: string | null) =>
        asAdmin(support).post(`/admin/support/tickets/${ticketId}/assign`, { adminUserId });

      const res = await assign(colleague.userId);
      expect(res.status).toBe(200);
      expect(successBody<AdminTicket>(res).data.assignedAdmin).toEqual({
        userId: colleague.userId,
        displayName: colleague.email,
      });
      const counts = async () => ({
        messages: (await knex()('support_messages').where({ ticket_id: ticketId })).length,
        events: (await api.eventsOf('support.ticket_assigned', ticketId)).length,
        audit: (await auditRows(ticketId)).length,
      });
      const before = await counts();
      expect((await assign(colleague.userId)).status).toBe(200);
      expect(await counts()).toEqual(before);

      const unassigned = await assign(null);
      expect(successBody<AdminTicket>(unassigned).data.assignedAdmin).toBeNull();
      expect((await timeline(support, ticketId))[0]?.body).toBe('Ticket unassigned');
      expect((await auditRows(ticketId)).map((row) => row.changes)).toEqual([
        { before: { assignedAdminUserId: null }, after: { assignedAdminUserId: colleague.userId } },
        { before: { assignedAdminUserId: colleague.userId }, after: { assignedAdminUserId: null } },
      ]);
    });

    it('422 for an assignee that is not an active admin; 400 without adminUserId; 409 on a closed ticket', async () => {
      const support = await admin();
      const suspended = await admin('suspended');
      const { buyer, ticketId } = await openedTicket();
      const assign = (body: object) =>
        asAdmin(support).post(`/admin/support/tickets/${ticketId}/assign`, body);
      for (const adminUserId of [suspended.userId, buyer.userId, UNKNOWN_ID]) {
        const res = await assign({ adminUserId });
        expect(res.status).toBe(422);
        expect(errorBody(res).error.code).toBe('SUPPORT_ASSIGNEE_INVALID');
      }
      expect((await assign({})).status).toBe(400);
      expect((await asAdmin(support).post(`/admin/support/tickets/${ticketId}/close`)).status).toBe(200);
      const closed = await assign({ adminUserId: support.userId });
      expect(closed.status).toBe(409);
      expect(errorBody(closed).error.code).toBe('SUPPORT_TICKET_CLOSED');
    });

    it('resolve then close: system lines, events, audit rows; resolved_at kept by the close (SU-12)', async () => {
      const support = await admin();
      const { buyer, ticketId } = await openedTicket();
      const resolved = await asAdmin(support).post(`/admin/support/tickets/${ticketId}/resolve`);
      expect(resolved.status).toBe(200);
      expect(successBody<AdminTicket>(resolved).data).toMatchObject({
        status: 'resolved',
        awaitingAdminSince: null,
      });
      const again = await asAdmin(support).post(`/admin/support/tickets/${ticketId}/resolve`);
      expect(again.status).toBe(409);
      expect(errorBody(again).error.code).toBe('SUPPORT_TICKET_INVALID_STATUS_TRANSITION');

      expect((await asAdmin(support).post(`/admin/support/tickets/${ticketId}/close`)).status).toBe(200);
      const row = await ticketRow(ticketId);
      expect(row?.status).toBe('closed');
      expect(row?.resolved_at).not.toBeNull();
      expect(row?.closed_at).not.toBeNull();
      expect((await asAdmin(support).post(`/admin/support/tickets/${ticketId}/close`)).status).toBe(409);

      const userView = successBody<TicketMessage[]>(
        await api.as(buyer.token).get(`/support/tickets/${ticketId}/messages`),
      ).data;
      expect(userView.slice(0, 2).map((m) => [m.body, m.sender.displayName])).toEqual([
        ['Closed by support', 'Nile Support'],
        ['Resolved by support', 'Nile Support'],
      ]);
      expect(
        (await api.eventsOf('support.ticket_status_changed', ticketId)).map((e) => [e.from, e.to, e.actor]),
      ).toEqual([
        ['open', 'resolved', 'admin'],
        ['resolved', 'closed', 'admin'],
      ]);
      expect((await auditRows(ticketId)).map((r) => [r.action, r.changes])).toEqual([
        ['support_ticket.resolved', { before: { status: 'open' }, after: { status: 'resolved' } }],
        ['support_ticket.closed', { before: { status: 'resolved' }, after: { status: 'closed' } }],
      ]);
    });
  });

  describe('the queue', () => {
    it('shows opener and assignee, filters, the oldest-waiting sort, and per-admin unread state', async () => {
      const support = await admin();
      const fresh = await openedTicket('Fresh one');
      const answered = await openedTicket('Answered one');
      expect((await reply(support, answered.ticketId, { body: 'Done?' })).status).toBe(201);
      const breached = await openedTicket('Waiting too long');
      await knex()('support_tickets')
        .where({ id: breached.ticketId })
        .update({ awaiting_admin_since: new Date('2026-01-01T00:00:00Z'), sla_breached_at: new Date() });

      const detail = successBody<AdminTicket>(
        await asAdmin(support).get(`/admin/support/tickets/${answered.ticketId}`),
      ).data;
      const buyerEmail = (
        await knex()('users').where({ id: answered.buyer.userId }).first<{ email: string }>('email')
      )?.email;
      expect(detail).toMatchObject({
        status: 'awaiting_user',
        opener: {
          userId: answered.buyer.userId,
          role: 'customer',
          displayName: 'Mona Ali',
          email: buyerEmail,
        },
        assignedAdmin: { userId: support.userId, displayName: support.email },
        hasUnread: false,
      });

      expect(await listIds(support, '&status[eq]=awaiting_user')).toContain(answered.ticketId);
      expect(await listIds(support, '&status[eq]=awaiting_user')).not.toContain(fresh.ticketId);
      expect(await listIds(support, `&assignedAdminId[eq]=${support.userId}`)).toEqual([answered.ticketId]);
      const unassigned = await listIds(support, '&assigned[eq]=false');
      expect(unassigned).toEqual(expect.arrayContaining([fresh.ticketId, breached.ticketId]));
      expect(unassigned).not.toContain(answered.ticketId);
      expect(await listIds(support, '&slaBreached[eq]=true')).toEqual([breached.ticketId]);
      expect(await listIds(support, '&slaBreached[eq]=false')).not.toContain(breached.ticketId);
      expect(await listIds(support, '&openerRole[eq]=seller')).not.toContain(fresh.ticketId);

      // The oldest-waiting queue: waiting tickets only, the longest wait first.
      const queue = await listIds(support, '&sort=awaitingAdminSince');
      expect(queue[0]).toBe(breached.ticketId);
      expect(queue).toContain(fresh.ticketId);
      expect(queue).not.toContain(answered.ticketId);

      const both = await asAdmin(support).get(
        `/admin/support/tickets?assigned[eq]=true&assignedAdminId[eq]=${support.userId}`,
      );
      expect(both.status).toBe(400);
      expect(errorBody(both).error.code).toBe('INVALID_QUERY');

      // Unread for an admin: a user message after their last read.
      const unread = async () =>
        successBody<AdminTicket>(await asAdmin(support).get(`/admin/support/tickets/${fresh.ticketId}`)).data
          .hasUnread;
      expect(await unread()).toBe(true);
      expect((await asAdmin(support).post(`/admin/support/tickets/${fresh.ticketId}/read`)).status).toBe(204);
      expect(await unread()).toBe(false);
    });

    it('names in the timeline: the opener, admins by email, the server as Nile Support (SU-7)', async () => {
      const [support, colleague] = [await admin(), await admin()];
      const { ticketId } = await openedTicket();
      await reply(support, ticketId, { body: 'Hello.' });
      await reply(colleague, ticketId, { body: 'Checking.', internal: true });
      const messages = await timeline(support, ticketId);
      expect(messages.map((m) => [m.kind, m.sender])).toEqual([
        ['internal_note', { role: 'admin', isMe: false, displayName: colleague.email }],
        ['system', { role: 'system', isMe: false, displayName: 'Nile Support' }],
        ['message', { role: 'admin', isMe: true, displayName: support.email }],
        ['message', { role: 'customer', isMe: false, displayName: 'Mona Ali' }],
      ]);
    });
  });

  describe('access', () => {
    it('401 without a token, 403 for customers and sellers, 404 for an unknown ticket', async () => {
      const { buyer, ticketId } = await openedTicket();
      expect((await request(t.app).get(`${API}/admin/support/tickets`)).status).toBe(401);
      const seller = await signTestAccessToken({ sub: randomUUID(), role: 'seller' });
      for (const token of [buyer.token, seller]) {
        expect((await api.as(token).get('/admin/support/tickets')).status).toBe(403);
        expect((await api.as(token).post(`/admin/support/tickets/${ticketId}/resolve`)).status).toBe(403);
      }
      const support = await admin();
      for (const res of [
        await asAdmin(support).get(`/admin/support/tickets/${UNKNOWN_ID}`),
        await asAdmin(support).get(`/admin/support/tickets/${UNKNOWN_ID}/messages`),
        await reply(support, UNKNOWN_ID, { body: 'Hi' }),
        await asAdmin(support).post(`/admin/support/tickets/${UNKNOWN_ID}/assign`, { adminUserId: null }),
        await asAdmin(support).post(`/admin/support/tickets/${UNKNOWN_ID}/resolve`),
        await asAdmin(support).post(`/admin/support/tickets/${UNKNOWN_ID}/close`),
        await asAdmin(support).post(`/admin/support/tickets/${UNKNOWN_ID}/read`),
      ]) {
        expect(res.status).toBe(404);
        expect(errorBody(res).error.code).toBe('SUPPORT_TICKET_NOT_FOUND');
      }
    });
  });
});
