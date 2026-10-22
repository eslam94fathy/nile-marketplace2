import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentBalancesDto,
  type LedgerEntryDto,
  type PayoutDto,
  type RemittanceDto,
  type SellerBalanceDto,
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

/* Spec 12 §4.2–§4.3 (FI-8, FI-11): sellers and agents read their own money. */
describe('finance: seller and agent self-service', () => {
  let t: TestApp;
  let adminToken: string;

  const knex = () => t.infra.db.knex;
  const fx = () => deliveryFixtures(knex());
  const get = (token: string, path: string) =>
    request(t.app).get(`${API}${path}`).set('Authorization', `Bearer ${token}`);
  const adminPost = (path: string, body: object) =>
    request(t.app)
      .post(`${API}${path}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const refused = (res: request.Response, status: number, code: string) =>
    expect([res.status, errorBody(res).error.code], JSON.stringify(res.body)).toEqual([status, code]);

  /**
   * A COD delivery booked through the ledger: seller net 90 (held, spec 12 §8.2), agent share 14, cash 160;
   * with `released`, its hold released as the job does (§8.3).
   */
  const delivered = async (sellerId: string, agentId: string, released = false) => {
    const sellerOrderId = randomUUID();
    const ledger = t.container.resolve<LedgerService>(TOKENS.LedgerService);
    await t.infra.db.run((trx) =>
      ledger.post(
        deliveryBooking(
          {
            sellerOrderId,
            sellerId,
            agentId,
            paymentMethod: 'cod',
            sellerNet: m('90.00'),
            commission: m('10.00'),
            platformDiscount: m('0.00'),
            agentFeeShare: m('14.00'),
            codCollectedAmount: m('160.00'),
            deliveryFeeCollected: true,
            deliveryFeeAmount: m('60.00'),
          },
          randomUUID(),
        ),
        trx,
      ),
    );
    if (released) {
      await t.infra.db.run((trx) =>
        ledger.post(holdReleaseBooking({ sellerOrderId, sellerId, heldAmount: m('90.00') }), trx),
      );
    }
  };
  async function seller(status = 'approved') {
    const { sellerId, userId } = await fx().insertSeller(status);
    return { sellerId, token: await signTestAccessToken({ sub: userId, role: 'seller' }) };
  }
  async function agent(overrides: Record<string, unknown> = {}) {
    const { agentId, userId } = await fx().insertAgent(overrides);
    return { agentId, token: await signTestAccessToken({ sub: userId, role: 'delivery_agent' }) };
  }

  beforeAll(async () => {
    t = await startTestApp();
    adminToken = await signTestAccessToken({ sub: await fx().insertUser('admin'), role: 'admin' });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('seller (§4.2)', () => {
    it('balance is 0.00 with no updatedAt before the first delivery, then what is owed', async () => {
      const me = await seller();
      expect(successBody<SellerBalanceDto>(await get(me.token, '/seller/finance/balance')).data).toEqual({
        available: '0.00',
        pending: '0.00',
        updatedAt: null,
      });
      expect(successBody<LedgerEntryDto[]>(await get(me.token, '/seller/finance/entries')).data).toEqual([]);

      await delivered(me.sellerId, randomUUID());
      const held = successBody<SellerBalanceDto>(await get(me.token, '/seller/finance/balance')).data;
      expect([held.available, held.pending]).toEqual(['0.00', '90.00']);
      expect(typeof held.updatedAt).toBe('string');

      await delivered(me.sellerId, randomUUID(), true);
      const balance = successBody<SellerBalanceDto>(await get(me.token, '/seller/finance/balance')).data;
      expect([balance.available, balance.pending]).toEqual(['90.00', '90.00']);
    });

    it('statement and payouts show only my own rows', async () => {
      const me = await seller();
      const other = await seller();
      await delivered(me.sellerId, randomUUID(), true);
      await delivered(other.sellerId, randomUUID(), true);
      for (const [payee, ref] of [
        [me.sellerId, 'MINE'],
        [other.sellerId, 'THEIRS'],
      ] as const) {
        const res = await adminPost('/admin/finance/payouts', {
          payeeType: 'seller',
          payeeId: payee,
          amount: '40.00',
          externalReference: ref,
          paidAt: PAST,
        });
        expect(res.status).toBe(201);
      }

      const entries = successBody<LedgerEntryDto[]>(await get(me.token, '/seller/finance/entries')).data;
      expect(entries.map((e) => [e.entryType, e.amount, e.balanceAfter])).toEqual([
        ['seller_payout', '40.00', '50.00'],
        ['seller_net_released', '90.00', '90.00'],
      ]);
      const filtered = successBody<LedgerEntryDto[]>(
        await get(me.token, '/seller/finance/entries?entryType=seller_payout'),
      ).data;
      expect(filtered).toHaveLength(1);
      const payouts = successBody<PayoutDto[]>(await get(me.token, '/seller/finance/payouts')).data;
      expect(payouts.map((p) => [p.externalReference, p.payeeId])).toEqual([['MINE', me.sellerId]]);
      // Another payee can't be asked for: there is no payee filter.
      refused(await get(me.token, `/seller/finance/payouts?payeeId=${other.sellerId}`), 400, 'INVALID_QUERY');
    });

    it('a suspended seller still reads its money (FI-8)', async () => {
      const me = await seller('suspended');
      await delivered(me.sellerId, randomUUID());
      expect(successBody<SellerBalanceDto>(await get(me.token, '/seller/finance/balance')).data.pending).toBe(
        '90.00',
      );
    });

    it('other roles are refused; a seller login without a profile is a 500 (P4-Q9)', async () => {
      const { token: agentToken } = await agent();
      refused(await get(agentToken, '/seller/finance/balance'), 403, 'FORBIDDEN');
      expect((await request(t.app).get(`${API}/seller/finance/entries`)).status).toBe(401);
      const orphan = await signTestAccessToken({ sub: await fx().insertUser('seller'), role: 'seller' });
      refused(await get(orphan, '/seller/finance/balance'), 500, 'INTERNAL_ERROR');
    });
  });

  describe('agent (§4.3)', () => {
    it('balances are 0.00 before any delivery, then fee shares and cash held', async () => {
      const me = await agent();
      expect(successBody<AgentBalancesDto>(await get(me.token, '/agent/finance/balances')).data).toEqual({
        feePayable: '0.00',
        codCashHeld: '0.00',
      });
      await delivered(randomUUID(), me.agentId);
      await delivered(randomUUID(), me.agentId);
      expect(successBody<AgentBalancesDto>(await get(me.token, '/agent/finance/balances')).data).toEqual({
        feePayable: '28.00',
        codCashHeld: '320.00',
      });
    });

    it('statement per account (fee or cod, required) and my remittances only', async () => {
      const me = await agent();
      const other = await agent();
      await delivered(randomUUID(), me.agentId);
      await delivered(randomUUID(), other.agentId);
      for (const agentId of [me.agentId, other.agentId]) {
        expect(
          (await adminPost('/admin/finance/cod-remittances', { agentId, amount: '100.00' })).status,
        ).toBe(201);
      }

      const fee = successBody<LedgerEntryDto[]>(
        await get(me.token, '/agent/finance/entries?account=fee'),
      ).data;
      expect(fee.map((e) => [e.entryType, e.amount])).toEqual([['agent_fee_earned', '14.00']]);
      const cod = successBody<LedgerEntryDto[]>(
        await get(me.token, '/agent/finance/entries?account=cod'),
      ).data;
      expect(cod.map((e) => [e.entryType, e.amount, e.balanceAfter])).toEqual([
        ['cod_cash_remitted', '100.00', '60.00'],
        ['cod_cash_collected', '160.00', '160.00'],
      ]);
      const page = successBody<LedgerEntryDto[]>(
        await get(me.token, '/agent/finance/entries?account=cod&limit=1'),
      );
      expect(page.meta).toMatchObject({ hasMore: true, limit: 1 });

      refused(await get(me.token, '/agent/finance/entries'), 400, 'INVALID_QUERY');
      refused(await get(me.token, '/agent/finance/entries?account=cash'), 400, 'INVALID_QUERY');
      refused(
        await get(me.token, '/agent/finance/entries?account=fee&entryType=bonus'),
        400,
        'INVALID_QUERY',
      );

      const remittances = successBody<RemittanceDto[]>(
        await get(me.token, '/agent/finance/remittances'),
      ).data;
      expect(remittances.map((r) => [r.agentId, r.amount])).toEqual([[me.agentId, '100.00']]);
    });

    it('an inactive agent still reads its money (FI-8); other roles are refused', async () => {
      const me = await agent({ status: 'inactive' });
      await delivered(randomUUID(), me.agentId);
      expect(
        successBody<AgentBalancesDto>(await get(me.token, '/agent/finance/balances')).data.codCashHeld,
      ).toBe('160.00');
      const { token: sellerToken } = await seller();
      refused(await get(sellerToken, '/agent/finance/balances'), 403, 'FORBIDDEN');
      refused(await get(sellerToken, '/agent/finance/remittances'), 403, 'FORBIDDEN');
    });
  });
});
