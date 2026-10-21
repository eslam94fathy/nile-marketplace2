import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ICustomerDirectory } from '../../src/app/customers';
import { type ISellerDirectory } from '../../src/app/sellers';
import { type ISupportDirectory, registerSupportLookups } from '../../src/app/support';
import { UserRole } from '../../src/lib/auth';
import { TOKENS } from '../../src/lib/di';
import { cartFixtures } from '../helpers/cart-fixtures';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';

/*
 * Spec 16 §2 (support's public API: canView for realtime, getStats for the back-office) and the
 * by-user-id name lookups of customers and sellers it uses in admin views (SU-8), on real Postgres.
 */
describe('support directory and name lookups', () => {
  let t: TestApp;
  let support: ISupportDirectory;
  let fx: ReturnType<typeof cartFixtures>;

  /** A ticket row as the service will write it; status fields per the D-18 CHECKs. */
  async function insertTicket(openerUserId: string, row: Record<string, unknown> = {}): Promise<string> {
    const now = new Date();
    const [created] = await t.infra.db
      .knex('support_tickets')
      .insert({
        ticket_number: t.infra.db.knex.raw(
          `'T-' || lpad(nextval('support_ticket_number_seq')::text, 9, '0')`,
        ),
        opener_user_id: openerUserId,
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
    if (!created) throw new Error('ticket not inserted');
    return created.id;
  }

  beforeAll(async () => {
    t = await startTestApp();
    registerSupportLookups(t.container);
    support = t.container.resolve<ISupportDirectory>(TOKENS.SupportDirectory);
    fx = cartFixtures(t.infra.db.knex);
  });
  afterAll(async () => {
    await t.close();
  });

  describe('canView', () => {
    it('the opener and any admin; not another user, an agent, or a missing ticket', async () => {
      const opener = await fx.insertCustomer();
      const other = await fx.insertCustomer();
      const ticketId = await insertTicket(opener.userId);

      expect(await support.canView(opener.userId, UserRole.CUSTOMER, ticketId)).toBe(true);
      expect(await support.canView(UNKNOWN_ID, UserRole.ADMIN, ticketId)).toBe(true);
      expect(await support.canView(other.userId, UserRole.CUSTOMER, ticketId)).toBe(false);
      // An agent never sees tickets, even with the opener's id.
      expect(await support.canView(opener.userId, UserRole.DELIVERY_AGENT, ticketId)).toBe(false);
      expect(await support.canView(opener.userId, UserRole.CUSTOMER, UNKNOWN_ID)).toBe(false);
      expect(await support.canView(opener.userId, UserRole.ADMIN, UNKNOWN_ID)).toBe(false);
    });
  });

  describe('getStats', () => {
    it('counts the waiting tickets; slaBreached only for those waiting now (SU-11)', async () => {
      const before = await support.getStats();
      const { userId } = await fx.insertCustomer();
      const breachedAt = new Date();
      await insertTicket(userId);
      await insertTicket(userId, { sla_breached_at: breachedAt });
      await insertTicket(userId, { status: 'awaiting_admin', sla_breached_at: breachedAt });
      // Not waiting: the flag of an earlier wait stays as history and isn't counted.
      await insertTicket(userId, {
        status: 'awaiting_user',
        awaiting_admin_since: null,
        sla_breached_at: breachedAt,
      });
      await insertTicket(userId, {
        status: 'resolved',
        awaiting_admin_since: null,
        resolved_at: breachedAt,
        sla_breached_at: breachedAt,
      });

      expect(await support.getStats()).toEqual({
        open: before.open + 2,
        awaitingAdmin: before.awaitingAdmin + 1,
        slaBreached: before.slaBreached + 2,
      });
    });
  });

  describe('name lookups by user id (SU-8)', () => {
    it('customers: "first last" per user id; unknown ids are left out', async () => {
      const customers = t.container.resolve<ICustomerDirectory>(TOKENS.CustomerDirectory);
      const { userId } = await fx.insertCustomer();
      const names = await customers.getFullNamesByUserIds([userId, userId, UNKNOWN_ID]);
      expect([...names]).toEqual([[userId, 'Mona Ali']]);
      expect(await customers.getFullNamesByUserIds([])).toEqual(new Map());
    });

    it('sellers: profile id and business name per user id, any seller status', async () => {
      const sellers = t.container.resolve<ISellerDirectory>(TOKENS.SellerDirectory);
      const pending = await fx.insertSeller('pending_approval');
      const approved = await fx.insertSeller('approved');
      const summaries = await sellers.getSummariesByUserIds([pending.userId, approved.userId, UNKNOWN_ID]);
      expect(summaries.size).toBe(2);
      expect(summaries.get(pending.userId)).toEqual({
        sellerId: pending.sellerId,
        businessName: expect.any(String) as unknown,
      });
      expect(summaries.get(approved.userId)?.sellerId).toBe(approved.sellerId);
    });
  });
});
