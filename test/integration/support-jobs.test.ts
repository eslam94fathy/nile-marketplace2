import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupportJobs } from '../../src/app/support';
import { createWorkerContainer } from '../../src/container';
import {
  closeInfrastructure,
  createWorkerInfrastructure,
  type WorkerInfrastructure,
} from '../../src/infrastructure';
import { type JobDefinition } from '../../src/lib/jobs';
import { cartFixtures } from '../helpers/cart-fixtures';
import { createMemoryLogger, type MemoryLogWriter } from '../helpers/memory-logger';
import { startTestApp, type TestApp } from '../helpers/test-app';

const HOUR_MS = 3_600_000;

/*
 * Spec 16 UC-SU-5 (`support-jobs` in the worker): auto-close of resolved tickets and the SLA flag, with
 * the P5-Q5 pattern (candidates without locks, one ticket per short transaction, SKIP LOCKED).
 */
describe('support jobs', () => {
  let t: TestApp;
  let worker: WorkerInfrastructure;
  let workerLogs: MemoryLogWriter;
  let job: JobDefinition;
  let fx: ReturnType<typeof cartFixtures>;
  const knex = () => t.infra.db.knex;
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);

  async function insertTicket(row: Record<string, unknown>): Promise<string> {
    const { userId } = await fx.insertCustomer();
    const now = new Date();
    const [created] = await knex()('support_tickets')
      .insert({
        ticket_number: knex().raw(`'T-' || lpad(nextval('support_ticket_number_seq')::text, 9, '0')`),
        opener_user_id: userId,
        opener_role: 'customer',
        category: 'other',
        subject: 'Where is it?',
        status: 'open',
        last_message_at: now,
        last_user_message_at: now,
        awaiting_admin_since: now,
        ...row,
      })
      .returning<{ id: string }[]>('id');
    if (!created) throw new Error('fixture');
    return created.id;
  }

  const resolvedHoursAgo = (hours: number) =>
    insertTicket({ status: 'resolved', awaiting_admin_since: null, resolved_at: hoursAgo(hours) });
  const ticketRow = (id: string) =>
    knex()('support_tickets').where({ id }).first<{
      status: string;
      closed_at: Date | null;
      resolved_at: Date | null;
      sla_breached_at: Date | null;
    }>('status', 'closed_at', 'resolved_at', 'sla_breached_at');
  const systemLines = (ticketId: string) =>
    knex()('support_messages').where({ ticket_id: ticketId, kind: 'system' }).pluck<string[]>('body');
  const statusEvents = async (ticketId: string) =>
    (
      await knex()('events_outbox')
        .where({ event_type: 'support.ticket_status_changed', aggregate_id: ticketId })
        .select<{ payload: Record<string, unknown> }[]>('payload')
    ).map((row) => row.payload);
  const slaLogs = (ticketId: string) =>
    workerLogs
      .entries()
      .filter((entry) => entry.event === 'SUPPORT_SLA_BREACHED' && entry.ticketId === ticketId);

  beforeAll(async () => {
    t = await startTestApp();
    fx = cartFixtures(knex());
    const { logger, writer } = createMemoryLogger();
    workerLogs = writer;
    // Same database as the api: a worker next to it.
    worker = await createWorkerInfrastructure(t.resources.workerEnv, logger);
    const [definition] = createSupportJobs(createWorkerContainer(worker), worker.env);
    if (!definition) throw new Error('no support job');
    job = definition;
  });
  afterAll(async () => {
    await closeInfrastructure(worker);
    await t.close();
  });

  it('is one job on JOB_SUPPORT_INTERVAL_MS', () => {
    expect(job).toMatchObject({ name: 'support-jobs', intervalMs: worker.env.JOB_SUPPORT_INTERVAL_MS });
  });

  describe('auto-close', () => {
    it('closes tickets resolved for longer than SUPPORT_AUTO_CLOSE_AFTER_HOURS, keeping resolved_at', async () => {
      const limit = worker.env.SUPPORT_AUTO_CLOSE_AFTER_HOURS;
      const old = await resolvedHoursAgo(limit + 1);
      const recent = await resolvedHoursAgo(limit - 1);
      const open = await insertTicket({});

      await job.run();

      const closed = await ticketRow(old);
      expect(closed?.status).toBe('closed');
      expect(closed?.closed_at).not.toBeNull();
      expect(closed?.resolved_at).not.toBeNull();
      expect(await systemLines(old)).toEqual(['Closed automatically after being resolved']);
      expect(await statusEvents(old)).toEqual([
        expect.objectContaining({ from: 'resolved', to: 'closed', actor: 'system' }),
      ]);
      expect((await ticketRow(recent))?.status).toBe('resolved');
      expect((await ticketRow(open))?.status).toBe('open');
    });

    it('two workers at once close each ticket once', async () => {
      const ids = [];
      for (let i = 0; i < 3; i += 1)
        ids.push(await resolvedHoursAgo(worker.env.SUPPORT_AUTO_CLOSE_AFTER_HOURS + 1));
      await Promise.all([job.run(), job.run()]);
      for (const id of ids) {
        expect((await ticketRow(id))?.status).toBe('closed');
        expect(await systemLines(id)).toHaveLength(1);
        expect(await statusEvents(id)).toHaveLength(1);
      }
    });

    it('skips a ticket another transaction holds and closes it on the next run', async () => {
      const id = await resolvedHoursAgo(worker.env.SUPPORT_AUTO_CLOSE_AFTER_HOURS + 1);
      const trx = await knex().transaction();
      try {
        await trx('support_tickets').where({ id }).forUpdate().select('id');
        await job.run();
        expect((await ticketRow(id))?.status).toBe('resolved');
      } finally {
        await trx.rollback();
      }
      await job.run();
      expect((await ticketRow(id))?.status).toBe('closed');
    });
  });

  describe('SLA flag', () => {
    it('flags tickets waiting for an admin past SUPPORT_SLA_HOURS, once per wait, with a warn', async () => {
      const late = hoursAgo(worker.env.SUPPORT_SLA_HOURS + 1);
      const open = await insertTicket({ awaiting_admin_since: late });
      const awaitingAdmin = await insertTicket({ status: 'awaiting_admin', awaiting_admin_since: late });
      const fresh = await insertTicket({});
      const answered = await insertTicket({ status: 'awaiting_user', awaiting_admin_since: null });
      workerLogs.clear();

      await job.run();

      for (const id of [open, awaitingAdmin]) {
        expect((await ticketRow(id))?.sla_breached_at).not.toBeNull();
        expect(slaLogs(id)).toEqual([expect.objectContaining({ level: 'warn' })]);
      }
      for (const id of [fresh, answered]) expect((await ticketRow(id))?.sla_breached_at).toBeNull();

      // Already flagged in this wait: nothing more, no second warn.
      const flaggedAt = (await ticketRow(open))?.sla_breached_at;
      await job.run();
      expect((await ticketRow(open))?.sla_breached_at).toEqual(flaggedAt);
      expect(slaLogs(open)).toHaveLength(1);
      // The flag is not a status change.
      expect(await statusEvents(open)).toEqual([]);
    });
  });
});
