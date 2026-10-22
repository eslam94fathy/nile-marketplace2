import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AccountDto,
  type LedgerEntryDto,
  type PayoutDto,
  type ReferenceEntryDto,
  type RemittanceDto,
} from '../../src/app/finance/dto/finance-response.dto';
import { deliveryBooking, holdReleaseBooking } from '../../src/app/finance/model/booking-rules';
import { type LedgerService } from '../../src/app/finance/service/ledger.service';
import { TOKENS } from '../../src/lib/di';
import { Money } from '../../src/lib/money';
import { deliveryFixtures } from '../helpers/delivery-fixtures';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { startTestApp, type TestApp } from '../helpers/test-app';

const m = (value: string) => Money.of(value);
const PAST = '2026-01-15T10:00:00.000Z';

/* Spec 12 §4.1 (FI-5…FI-9, FI-11): the admin finance endpoints. */
describe('finance: admin API', () => {
  let t: TestApp;
  let adminToken: string;
  let adminId: string;
  let customerToken: string;

  const knex = () => t.infra.db.knex;
  const fx = () => deliveryFixtures(knex());
  const as = (token: string) => ({
    get: (path: string) => request(t.app).get(`${API}${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object, key: string | null = randomUUID()) => {
      const req = request(t.app).post(`${API}${path}`).set('Authorization', `Bearer ${token}`);
      return (key ? req.set('Idempotency-Key', key) : req).send(body);
    },
  });
  const admin = () => as(adminToken);
  const refused = (res: request.Response, status: number, code: string) =>
    expect([res.status, errorBody(res).error.code], JSON.stringify(res.body)).toEqual([status, code]);
  /** A fresh UUID v7 (the API accepts only v7 ids). */
  const v7 = async () =>
    (await knex().raw<{ rows: { id: string }[] }>('SELECT uuidv7() AS id')).rows[0]?.id ?? '';

  /**
   * A COD delivery booked through the ledger (seller net 90, commission 10, share 14, cash 160 with the fee),
   * its hold then released as the job does (spec 12 §8.3), so the net is payable.
   */
  async function delivered(options: {
    sellerId: string;
    agentId: string;
    sellerNet?: string;
    cash?: string;
  }) {
    const sellerOrderId = randomUUID();
    await t.infra.db.run((trx) =>
      t.container.resolve<LedgerService>(TOKENS.LedgerService).post(
        deliveryBooking(
          {
            sellerOrderId,
            sellerId: options.sellerId,
            agentId: options.agentId,
            paymentMethod: 'cod',
            sellerNet: m(options.sellerNet ?? '90.00'),
            commission: m('10.00'),
            agentFeeShare: m('14.00'),
            codCollectedAmount: m(options.cash ?? '160.00'),
            deliveryFeeCollected: true,
            deliveryFeeAmount: m('60.00'),
          },
          randomUUID(),
        ),
        trx,
      ),
    );
    await t.infra.db.run((trx) =>
      t.container.resolve<LedgerService>(TOKENS.LedgerService).post(
        holdReleaseBooking({
          sellerOrderId,
          sellerId: options.sellerId,
          heldAmount: m(options.sellerNet ?? '90.00'),
        }),
        trx,
      ),
    );
    return sellerOrderId;
  }
  const accountOf = async (accountType: string, ownerId: string) =>
    knex()('finance_accounts')
      .where({ account_type: accountType, owner_id: ownerId })
      .first<{ id: string; balance: string } | undefined>('id', 'balance');

  beforeAll(async () => {
    t = await startTestApp();
    adminId = await fx().insertUser('admin');
    adminToken = await signTestAccessToken({ sub: adminId, role: 'admin' });
    customerToken = await signTestAccessToken({ sub: await fx().insertUser('customer'), role: 'customer' });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('accounts and statements', () => {
    it('lists accounts with owner names; platform accounts have none (FI-11)', async () => {
      const { sellerId } = await fx().insertSeller();
      const { agentId } = await fx().insertAgent({ full_name: 'Finance Agent' });
      await delivered({ sellerId, agentId });
      const business = await knex()('sellers')
        .where({ id: sellerId })
        .first<{ business_name: string }>('business_name');

      const own = successBody<AccountDto[]>(
        await admin().get(`/admin/finance/accounts?ownerId=${sellerId}`),
      ).data;
      expect(own.map((a) => [a.accountType, a.ownerId, a.ownerName, a.balance]).sort()).toEqual([
        ['seller_payable', sellerId, business?.business_name, '90.00'],
        ['seller_pending', sellerId, business?.business_name, '0.00'],
      ]);
      const agent = successBody<AccountDto[]>(
        await admin().get(`/admin/finance/accounts?ownerId[eq]=${agentId}&sort=updatedAt`),
      ).data;
      expect(agent.map((a) => [a.accountType, a.ownerName, a.balance]).sort()).toEqual([
        ['agent_cod_cash', 'Finance Agent', '160.00'],
        ['agent_fee_payable', 'Finance Agent', '14.00'],
      ]);
      const platform = successBody<AccountDto[]>(
        await admin().get(
          '/admin/finance/accounts?accountType[in]=platform_commission_revenue,platform_delivery_revenue',
        ),
      ).data;
      expect(platform).toHaveLength(2);
      expect(platform.every((a) => a.ownerId === null && a.ownerName === null)).toBe(true);
    });

    it('pages by balance (default -balance) with ties and both directions', async () => {
      const agentId = randomUUID();
      const sellers = [];
      for (const net of ['9001.00', '9002.00', '9002.00']) {
        const { sellerId } = await fx().insertSeller();
        await delivered({ sellerId, agentId, sellerNet: net });
        sellers.push(sellerId);
      }
      const pageThrough = async (sort: string) => {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const res = await admin().get(
            `/admin/finance/accounts?accountType=seller_payable&balance[gte]=9000&limit=2${sort}${cursor ? `&cursor=${cursor}` : ''}`,
          );
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          const body = successBody<AccountDto[]>(res);
          seen.push(...body.data.map((a) => a.balance));
          cursor = body.meta?.nextCursor ?? null;
        } while (cursor);
        return seen;
      };
      expect(await pageThrough('')).toEqual(['9002.00', '9002.00', '9001.00']);
      expect(await pageThrough('&sort=balance')).toEqual(['9001.00', '9002.00', '9002.00']);
    });

    it('rejects unknown filters and operators, and non-admins', async () => {
      refused(await admin().get('/admin/finance/accounts?balance[lt]=10'), 400, 'INVALID_QUERY');
      refused(await admin().get('/admin/finance/accounts?owner=x'), 400, 'INVALID_QUERY');
      refused(await admin().get('/admin/finance/accounts?accountType=wallet'), 400, 'INVALID_QUERY');
      refused(await as(customerToken).get('/admin/finance/accounts'), 403, 'FORBIDDEN');
      expect((await request(t.app).get(`${API}/admin/finance/accounts`)).status).toBe(401);
    });

    it('shows one account and its statement; unknown accounts are 404', async () => {
      const { sellerId } = await fx().insertSeller();
      const agentId = randomUUID();
      await delivered({ sellerId, agentId });
      await delivered({ sellerId, agentId, sellerNet: '45.00' });
      const account = await accountOf('seller_payable', sellerId);

      const one = successBody<AccountDto>(await admin().get(`/admin/finance/accounts/${account?.id}`)).data;
      expect(one).toMatchObject({ id: account?.id, balance: '135.00', accountType: 'seller_payable' });
      const statement = successBody<LedgerEntryDto[]>(
        await admin().get(`/admin/finance/accounts/${account?.id}/entries?entryType=seller_net_released`),
      );
      expect(statement.data.map((e) => [e.amount, e.balanceAfter])).toEqual([
        ['45.00', '135.00'],
        ['90.00', '90.00'],
      ]);
      expect(statement.meta).toMatchObject({ hasMore: false });

      const unknown = await v7();
      refused(await admin().get(`/admin/finance/accounts/${unknown}`), 404, 'ACCOUNT_NOT_FOUND');
      refused(await admin().get(`/admin/finance/accounts/${unknown}/entries`), 404, 'ACCOUNT_NOT_FOUND');
      refused(await admin().get('/admin/finance/accounts/not-a-uuid'), 400, 'VALIDATION_FAILED');
    });

    it('lists every entry of one reference, with its account; both filters are required (FI-9)', async () => {
      const { sellerId } = await fx().insertSeller();
      const agentId = randomUUID();
      const sellerOrderId = await delivered({ sellerId, agentId });
      const entries = successBody<ReferenceEntryDto[]>(
        await admin().get(`/admin/finance/entries?referenceType=seller_order&referenceId=${sellerOrderId}`),
      ).data;
      expect(entries.map((e) => e.entryType)).toEqual([
        'seller_net_held',
        'commission_earned',
        'agent_fee_earned',
        'agent_fee_earned',
        'cod_cash_collected',
        'platform_fee_earned',
      ]);
      expect(entries.every((e) => typeof e.accountId === 'string' && e.referenceId === sellerOrderId)).toBe(
        true,
      );

      refused(await admin().get(`/admin/finance/entries?referenceId=${sellerOrderId}`), 400, 'INVALID_QUERY');
      refused(await admin().get('/admin/finance/entries?referenceType=order'), 400, 'INVALID_QUERY');
      refused(
        await admin().get(`/admin/finance/entries?referenceType=shipment&referenceId=${sellerOrderId}`),
        400,
        'INVALID_QUERY',
      );
    });
  });

  describe('COD remittances (FI-5)', () => {
    it('debits the agent cash, records the remittance and its event; a replay returns the same body', async () => {
      const { agentId } = await fx().insertAgent();
      await delivered({ sellerId: randomUUID(), agentId });
      const key = randomUUID();
      const res = await admin().post(
        '/admin/finance/cod-remittances',
        { agentId, amount: '100.00', note: 'Handed in at the hub' },
        key,
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const remittance = successBody<RemittanceDto>(res).data;
      expect(remittance).toMatchObject({
        agentId,
        amount: '100.00',
        confirmedByUserId: adminId,
        note: 'Handed in at the hub',
      });
      expect((await accountOf('agent_cod_cash', agentId))?.balance).toBe('60.00');

      const entries = successBody<ReferenceEntryDto[]>(
        await admin().get(`/admin/finance/entries?referenceType=cod_remittance&referenceId=${remittance.id}`),
      ).data;
      expect(entries).toEqual([
        expect.objectContaining({
          direction: 'debit',
          amount: '100.00',
          balanceAfter: '60.00',
          entryType: 'cod_cash_remitted',
        }),
      ]);
      const events = await knex()('events_outbox')
        .where({ event_type: 'cod.remittance_confirmed', aggregate_id: remittance.id })
        .select<{ payload: Record<string, unknown> }[]>('payload');
      expect(events.map((e) => e.payload)).toEqual([
        { remittanceId: remittance.id, agentId, amount: '100.00', confirmedByUserId: adminId },
      ]);

      const replay = await admin().post(
        '/admin/finance/cod-remittances',
        { agentId, amount: '100.00', note: 'Handed in at the hub' },
        key,
      );
      expect([replay.status, successBody<RemittanceDto>(replay).data.id]).toEqual([201, remittance.id]);
      expect((await accountOf('agent_cod_cash', agentId))?.balance).toBe('60.00');
    });

    it('over the balance, or with no cash account yet → REMITTANCE_EXCEEDS_BALANCE; unknown agent → AGENT_NOT_FOUND', async () => {
      const { agentId } = await fx().insertAgent();
      await delivered({ sellerId: randomUUID(), agentId });
      refused(
        await admin().post('/admin/finance/cod-remittances', { agentId, amount: '160.01' }),
        422,
        'REMITTANCE_EXCEEDS_BALANCE',
      );
      expect((await accountOf('agent_cod_cash', agentId))?.balance).toBe('160.00');

      // Inactive agents may remit too, but this one holds nothing; its account isn't left behind.
      const { agentId: idle } = await fx().insertAgent({ status: 'inactive' });
      refused(
        await admin().post('/admin/finance/cod-remittances', { agentId: idle, amount: '1.00' }),
        422,
        'REMITTANCE_EXCEEDS_BALANCE',
      );
      expect(await accountOf('agent_cod_cash', idle)).toBeUndefined();

      refused(
        await admin().post('/admin/finance/cod-remittances', { agentId: await v7(), amount: '1.00' }),
        422,
        'AGENT_NOT_FOUND',
      );
    });

    it('validates the body and requires an Idempotency-Key', async () => {
      const { agentId } = await fx().insertAgent();
      for (const body of [
        { agentId, amount: '0.00' },
        { agentId, amount: 10 },
        { agentId, amount: '10.00', note: null },
        { agentId, amount: '10.00', note: 'x'.repeat(501) },
        { agentId: randomUUID(), amount: '10.00' },
        { agentId, amount: '10.00', extra: true },
      ]) {
        refused(await admin().post('/admin/finance/cod-remittances', body), 400, 'VALIDATION_FAILED');
      }
      refused(
        await admin().post('/admin/finance/cod-remittances', { agentId, amount: '1.00' }, null),
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
      );
      refused(
        await as(customerToken).post('/admin/finance/cod-remittances', { agentId, amount: '1.00' }),
        403,
        'FORBIDDEN',
      );
    });

    it('lists remittances, filtered by agent', async () => {
      const { agentId } = await fx().insertAgent();
      await delivered({ sellerId: randomUUID(), agentId });
      for (const amount of ['10.00', '20.00']) {
        expect((await admin().post('/admin/finance/cod-remittances', { agentId, amount })).status).toBe(201);
      }
      const list = successBody<RemittanceDto[]>(
        await admin().get(`/admin/finance/cod-remittances?agentId=${agentId}`),
      );
      expect(list.data.map((r) => r.amount)).toEqual(['20.00', '10.00']);
      expect(list.data.every((r) => r.note === null)).toBe(true);
      expect((await admin().get('/admin/finance/cod-remittances?limit=1')).status).toBe(200);
    });
  });

  describe('payouts (FI-6, FI-7, FI-9)', () => {
    it('pays a seller and an agent: balance down, payout and event recorded', async () => {
      const { sellerId } = await fx().insertSeller('suspended');
      const { agentId } = await fx().insertAgent({ status: 'inactive' });
      await delivered({ sellerId, agentId });

      const res = await admin().post('/admin/finance/payouts', {
        payeeType: 'seller',
        payeeId: sellerId,
        amount: '90.00',
        externalReference: 'BANK-001',
        paidAt: PAST,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const payout = successBody<PayoutDto>(res).data;
      expect(payout).toMatchObject({
        payeeType: 'seller',
        payeeId: sellerId,
        amount: '90.00',
        externalReference: 'BANK-001',
        recordedByUserId: adminId,
        paidAt: PAST,
      });
      expect((await accountOf('seller_payable', sellerId))?.balance).toBe('0.00');
      const events = await knex()('events_outbox')
        .where({ event_type: 'payout.recorded', aggregate_id: payout.id })
        .select<{ payload: Record<string, unknown> }[]>('payload');
      expect(events.map((e) => e.payload)).toEqual([
        {
          payoutId: payout.id,
          payeeType: 'seller',
          payeeId: sellerId,
          amount: '90.00',
          recordedByUserId: adminId,
        },
      ]);

      const agentPayout = await admin().post('/admin/finance/payouts', {
        payeeType: 'agent',
        payeeId: agentId,
        amount: '14.00',
        externalReference: 'WALLET-7',
        paidAt: '2026-01-15T12:00:00+02:00',
      });
      expect(agentPayout.status).toBe(201);
      expect((await accountOf('agent_fee_payable', agentId))?.balance).toBe('0.00');
      // The agent's COD cash is a different account: untouched.
      expect((await accountOf('agent_cod_cash', agentId))?.balance).toBe('160.00');
      const entries = successBody<ReferenceEntryDto[]>(
        await admin().get(
          `/admin/finance/entries?referenceType=payout&referenceId=${successBody<PayoutDto>(agentPayout).data.id}`,
        ),
      ).data;
      expect(entries).toEqual([
        expect.objectContaining({ entryType: 'agent_payout', direction: 'debit', amount: '14.00' }),
      ]);
    });

    it('refuses more than the balance, unknown payees, a reused reference and a future paidAt', async () => {
      const { sellerId } = await fx().insertSeller();
      await delivered({ sellerId, agentId: randomUUID() });
      const payout = (overrides: Record<string, unknown>) =>
        admin().post('/admin/finance/payouts', {
          payeeType: 'seller',
          payeeId: sellerId,
          amount: '10.00',
          externalReference: `REF-${randomUUID()}`,
          paidAt: PAST,
          ...overrides,
        });
      refused(await payout({ amount: '90.01' }), 422, 'PAYOUT_EXCEEDS_BALANCE');
      const { sellerId: unpaid } = await fx().insertSeller();
      refused(await payout({ payeeId: unpaid }), 422, 'PAYOUT_EXCEEDS_BALANCE');
      refused(await payout({ payeeId: await v7() }), 422, 'PAYEE_NOT_FOUND');
      refused(await payout({ payeeType: 'agent' }), 422, 'PAYEE_NOT_FOUND');
      refused(
        await payout({ paidAt: new Date(Date.now() + 60_000).toISOString() }),
        422,
        'PAID_AT_IN_FUTURE',
      );

      expect((await payout({ externalReference: 'BANK-DUP' })).status).toBe(201);
      refused(await payout({ externalReference: 'BANK-DUP' }), 409, 'PAYOUT_ALREADY_RECORDED');
      expect((await accountOf('seller_payable', sellerId))?.balance).toBe('80.00');
    });

    it('validates the body', async () => {
      const { sellerId } = await fx().insertSeller();
      const base = {
        payeeType: 'seller',
        payeeId: sellerId,
        amount: '1.00',
        externalReference: 'R',
        paidAt: PAST,
      };
      for (const overrides of [
        { payeeType: 'customer' },
        { amount: '-1.00' },
        { externalReference: '' },
        { externalReference: 'x'.repeat(201) },
        { paidAt: '2026-01-15' },
        { paidAt: '2026-01-15T10:00:00' },
        { paidAt: 'yesterday' },
      ]) {
        refused(
          await admin().post('/admin/finance/payouts', { ...base, ...overrides }),
          400,
          'VALIDATION_FAILED',
        );
      }
    });

    it('two parallel payouts that together exceed the balance: exactly one succeeds', async () => {
      const { sellerId } = await fx().insertSeller();
      await delivered({ sellerId, agentId: randomUUID() });
      const results = await Promise.all(
        ['A', 'B'].map((ref) =>
          admin().post('/admin/finance/payouts', {
            payeeType: 'seller',
            payeeId: sellerId,
            amount: '60.00',
            externalReference: ref,
            paidAt: PAST,
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect((await accountOf('seller_payable', sellerId))?.balance).toBe('30.00');
    });

    it('lists payouts, filtered by payee', async () => {
      const { sellerId } = await fx().insertSeller();
      await delivered({ sellerId, agentId: randomUUID() });
      for (const ref of ['P-1', 'P-2']) {
        await admin().post('/admin/finance/payouts', {
          payeeType: 'seller',
          payeeId: sellerId,
          amount: '5.00',
          externalReference: ref,
          paidAt: PAST,
        });
      }
      const list = successBody<PayoutDto[]>(
        await admin().get(`/admin/finance/payouts?payeeType=seller&payeeId=${sellerId}`),
      ).data;
      expect(list.map((p) => p.externalReference)).toEqual(['P-2', 'P-1']);
      refused(await admin().get('/admin/finance/payouts?payeeType=customer'), 400, 'INVALID_QUERY');
      refused(await as(customerToken).get('/admin/finance/payouts'), 403, 'FORBIDDEN');
    });
  });
});
