import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerContainer } from '../../src/container';
import { createEventHandlers } from '../../src/event-handlers';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { EventConsumerHost, OutboxDrainer } from '../../src/lib/events';
import { waitFor } from '../helpers/amqp-probe';
import { successBody } from '../helpers/http';
import { signTestAccessToken } from '../helpers/jwt';
import { createMemoryLogger } from '../helpers/memory-logger';
import { orderingApi } from '../helpers/ordering-api';
import { connectSocket, startTestGateway, type TestGateway, type TestSocket } from '../helpers/realtime';
import { startTestApp, type TestApp } from '../helpers/test-app';

const ORIGIN = 'https://app.nile.test';
const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

/*
 * Spec 16 on the socket (spec 15 §3.1, §3.3) and in the notification centre (spec 13 §8.2), end to end:
 * the api writes the support events, the worker fans them out and stores the notifications, and two
 * gateway tasks share one Redis adapter.
 */
describe('support: realtime and notifications', () => {
  let t: TestApp;
  let api: ReturnType<typeof orderingApi>;
  let first: TestGateway;
  let second: TestGateway;
  let worker: WorkerInfrastructure;
  let drainer: OutboxDrainer;
  const sockets: TestSocket[] = [];
  const knex = () => t.infra.db.knex;

  const open = async (url: string, token: string) => {
    const socket = await connectSocket(url, { token, origin: ORIGIN });
    sockets.push(socket);
    return socket;
  };
  const deliver = async (until: () => boolean) => {
    await drainer.drainOnce();
    await waitFor(until, 10_000);
  };
  const subscribe = (socket: TestSocket, payload: unknown) =>
    socket.socket.emitWithAck('ticket.subscribe', payload) as Promise<{ ok: boolean; code?: string }>;

  async function admin() {
    const userId = await api.fx.insertUser('admin');
    return { userId, token: await signTestAccessToken({ sub: userId, role: 'admin' }) };
  }

  async function openedTicket() {
    const buyer = await api.customer();
    const res = await api
      .as(buyer.token)
      .post('/support/tickets', { category: 'order', subject: 'Where is it?', body: 'A week late.' });
    expect(res.status).toBe(201);
    return { buyer, ticket: successBody<{ id: string; ticketNumber: string }>(res).data };
  }

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { CORS_ALLOWED_ORIGINS: ORIGIN } });
    api = orderingApi(t);
    await api.init();
    first = await startTestGateway(t.resources.realtimeEnv);
    second = await startTestGateway(t.resources.realtimeEnv);

    const { logger } = createMemoryLogger();
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
    const container = createWorkerContainer(worker);
    await worker.broker.assertExchange(worker.env.RABBITMQ_EXCHANGE);
    const consumers = new EventConsumerHost(worker.broker, worker.db, logger, worker.env);
    for (const handler of createEventHandlers(container)) await consumers.start(handler);
    drainer = new OutboxDrainer(worker.db.knex, worker.broker, worker.clock, logger, {
      exchange: worker.env.RABBITMQ_EXCHANGE,
      batchSize: worker.env.OUTBOX_BATCH_SIZE,
      maxBackoffMs: worker.env.OUTBOX_MAX_BACKOFF_MS,
    });
  });
  afterAll(async () => {
    for (const { socket } of sockets) socket.close();
    await first.close();
    await second.close();
    await closeInfrastructure(worker);
    await t.close();
  });

  it('ticket.subscribe: the opener and any admin; another user or a bad payload are refused', async () => {
    const { buyer, ticket } = await openedTicket();
    const stranger = await api.customer();
    const support = await admin();

    expect(await subscribe(await open(first.url, buyer.token), { ticketId: ticket.id })).toEqual({
      ok: true,
    });
    expect(await subscribe(await open(second.url, support.token), { ticketId: ticket.id })).toEqual({
      ok: true,
    });
    const strangerSocket = await open(first.url, stranger.token);
    for (const ticketId of [ticket.id, UNKNOWN_ID]) {
      expect(await subscribe(strangerSocket, { ticketId })).toEqual({
        ok: false,
        code: 'SUPPORT_TICKET_NOT_FOUND',
      });
    }
    // A fresh socket: the signal limit (RT-5) counts per socket.
    const buyerAgain = await open(second.url, buyer.token);
    for (const payload of [{ ticketId: 'nope' }, {}, { ticketId: ticket.id, extra: 1 }, 'x']) {
      expect(await subscribe(buyerAgain, payload)).toEqual({ ok: false, code: 'VALIDATION_FAILED' });
    }
  });

  it('live updates: admins see new tickets; the opener sees replies and status, never internal notes', async () => {
    const support = await admin();
    const adminSocket = await open(second.url, support.token);
    const { buyer, ticket } = await openedTicket();
    const buyerSocket = await open(first.url, buyer.token);
    expect(await subscribe(buyerSocket, { ticketId: ticket.id })).toEqual({ ok: true });

    // A new ticket reaches the admins room (NO-9): its state and its first message.
    await deliver(() =>
      adminSocket
        .of('support.ticket_updated')
        .some((m) => (m.data as { ticketId: string }).ticketId === ticket.id),
    );
    expect(
      adminSocket
        .of('support.ticket_updated')
        .find((m) => (m.data as { ticketId: string }).ticketId === ticket.id)?.data,
    ).toEqual({
      ticketId: ticket.id,
      status: 'open',
      assignedAdminId: null,
    });

    const note = await api
      .as(support.token)
      .post(`/admin/support/tickets/${ticket.id}/messages`, { body: 'Check the courier.', internal: true });
    const reply = await api
      .as(support.token)
      .post(`/admin/support/tickets/${ticket.id}/messages`, { body: 'We are on it.' });
    const replyId = successBody<{ id: string }>(reply).data.id;
    await deliver(() =>
      buyerSocket
        .of('support.message_created')
        .some((m) => (m.data as { messageId: string }).messageId === replyId),
    );
    await waitFor(() =>
      buyerSocket
        .of('support.ticket_updated')
        .some((m) => (m.data as { status: string }).status === 'awaiting_user'),
    );

    const noteId = successBody<{ id: string }>(note).data.id;
    const seenByBuyer = buyerSocket
      .of('support.message_created')
      .map((m) => (m.data as { messageId: string }).messageId);
    expect(seenByBuyer).toContain(replyId);
    expect(seenByBuyer).not.toContain(noteId);
    expect(
      adminSocket.of('support.message_created').map((m) => (m.data as { messageId: string }).messageId),
    ).toContain(noteId);
    expect(buyerSocket.of('support.ticket_updated').at(-1)?.data).toEqual({
      ticketId: ticket.id,
      status: 'awaiting_user',
      assignedAdminId: support.userId,
    });
    // Ids and statuses only: no bodies, names or emails on the socket.
    expect(JSON.stringify(buyerSocket.messages)).not.toMatch(/on it|courier|Mona|@/);
  });

  it('notifications: a reply to the opener, a user message to the assignee, resolved to the opener (NO-31)', async () => {
    const support = await admin();
    const { buyer, ticket } = await openedTicket();
    const buyerSocket = await open(first.url, buyer.token);
    const adminSocket = await open(second.url, support.token);
    const as = api.as(support.token);
    expect((await as.post(`/admin/support/tickets/${ticket.id}/messages`, { body: 'Hello.' })).status).toBe(
      201,
    );
    expect(
      (await api.as(buyer.token).post(`/support/tickets/${ticket.id}/messages`, { body: 'Still waiting.' }))
        .status,
    ).toBe(201);
    expect((await as.post(`/admin/support/tickets/${ticket.id}/resolve`)).status).toBe(200);

    const rowsOf = (userId: string) =>
      knex()('user_notifications')
        .where({ user_id: userId })
        .orderBy('id')
        .select<{ type: string; body: string; link: string }[]>('type', 'body', 'link');
    await deliver(
      () =>
        buyerSocket.of('notification.created').length >= 2 &&
        adminSocket.of('notification.created').length >= 1,
    );
    expect(await rowsOf(buyer.userId)).toEqual([
      {
        type: 'support_reply',
        body: `Support replied on ${ticket.ticketNumber}.`,
        link: `/support/tickets/${ticket.id}`,
      },
      {
        type: 'support_resolved',
        body: `${ticket.ticketNumber} was marked resolved.`,
        link: `/support/tickets/${ticket.id}`,
      },
    ]);
    expect(await rowsOf(support.userId)).toEqual([
      {
        type: 'support_user_message',
        body: `${ticket.ticketNumber} has a new message.`,
        link: `/admin/support/tickets/${ticket.id}`,
      },
    ]);
  });

  it('support.typing: relayed to the others in the joined ticket room, across tasks; not without joining', async () => {
    const support = await admin();
    const { buyer, ticket } = await openedTicket();
    const buyerSocket = await open(first.url, buyer.token);
    const adminSocket = await open(second.url, support.token);
    expect(await subscribe(buyerSocket, { ticketId: ticket.id })).toEqual({ ok: true });

    // The admin hasn't joined yet: nothing is relayed.
    adminSocket.socket.emit('support.typing', { ticketId: ticket.id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(buyerSocket.of('support.typing')).toEqual([]);

    expect(await subscribe(adminSocket, { ticketId: ticket.id })).toEqual({ ok: true });
    adminSocket.socket.emit('support.typing', { ticketId: ticket.id });
    await waitFor(() => buyerSocket.of('support.typing').length > 0, 5_000);
    expect(buyerSocket.of('support.typing')[0]?.data).toEqual({
      ticketId: ticket.id,
      userId: support.userId,
      role: 'admin',
    });
    expect(adminSocket.of('support.typing')).toEqual([]);

    // Unsubscribed: typing no longer reaches the opener.
    expect(await buyerSocket.socket.emitWithAck('ticket.unsubscribe', { ticketId: ticket.id })).toEqual({
      ok: true,
    });
    adminSocket.socket.emit('support.typing', { ticketId: ticket.id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(buyerSocket.of('support.typing')).toHaveLength(1);
  });
});
