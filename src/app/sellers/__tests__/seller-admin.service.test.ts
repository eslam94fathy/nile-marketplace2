import { container as rootContainer } from 'tsyringe';
import { describe, expect, it, vi } from 'vitest';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type OutboxEvent } from '../../../lib/events';
import { Rate } from '../../../lib/money';
import { SellerStatus } from '../enums';
import { Seller } from '../model/seller.model';
import { SellerAdminService } from '../service/seller-admin.service';

const TRX = { isTransaction: true } as unknown as DbTransaction;
const NOW = new Date('2026-10-09T12:00:00.000Z');

const makeSeller = (status: SellerStatus, rate = '0.1000') =>
  new Seller({
    id: 's-1',
    userId: 'u-1',
    businessName: 'Nile Crafts',
    contactPhone: '+201001234567',
    pickup: { governorateId: 'g-1', city: 'Cairo', area: 'A', street: 'S', building: '1', landmark: null },
    status,
    commissionRate: Rate.of(rate),
    rejectionReason: null,
    approvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

function setup(current: Seller | undefined, options: { emailVerified?: boolean } = {}) {
  const sellers = {
    findById: vi.fn((): Promise<Seller | undefined> => Promise.resolve(current)),
    transitionStatus: vi.fn(
      (_id: string, _from: SellerStatus, to: SellerStatus): Promise<Seller | undefined> =>
        Promise.resolve(makeSeller(to)),
    ),
    updateCommissionRate: vi.fn(() => Promise.resolve(current)),
  };
  const statusHistory = {
    insert: vi.fn(() => Promise.resolve()),
    listBySeller: vi.fn(() => Promise.resolve([])),
  };
  const commissionHistory = {
    insert: vi.fn(() => Promise.resolve()),
    listBySeller: vi.fn(() => Promise.resolve([])),
  };
  const accounts = {
    getUsersByIds: vi.fn(() =>
      Promise.resolve([
        {
          id: 'u-1',
          email: 'shop@example.com',
          emailVerifiedAt: options.emailVerified === false ? null : NOW,
        },
      ]),
    ),
  };
  const outbox = { add: vi.fn((_trx: DbTransaction, _event: OutboxEvent<object>) => Promise.resolve()) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() };
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.SellerRepository, { useValue: sellers });
  container.register(TOKENS.SellerStatusHistoryRepository, { useValue: statusHistory });
  container.register(TOKENS.SellerCommissionHistoryRepository, { useValue: commissionHistory });
  container.register(TOKENS.SellerSettingsRepository, { useValue: {} });
  container.register(TOKENS.AccountService, { useValue: accounts });
  container.register(TOKENS.Outbox, { useValue: outbox });
  container.register(TOKENS.TransactionRunner, {
    useValue: { run: <T>(work: (trx: DbTransaction) => Promise<T>) => work(TRX) },
  });
  container.register(TOKENS.Logger, { useValue: { ...logger, child: () => logger } });
  return {
    sellers,
    statusHistory,
    commissionHistory,
    outbox,
    service: container.resolve(SellerAdminService),
  };
}

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (e: { code?: string }) => e.code,
  );

describe('sellers SellerAdminService (spec 05 UC-SE-3)', () => {
  describe('approve', () => {
    it('pending + verified: conditional update, history row, seller.approved (pending_approval), clears the reason', async () => {
      const { service, sellers, statusHistory, outbox } = setup(makeSeller(SellerStatus.PENDING_APPROVAL));

      await service.approve('s-1', 'admin-1');

      expect(sellers.transitionStatus).toHaveBeenCalledWith('s-1', 'pending_approval', 'approved', TRX, {
        rejectionReason: null,
        setApprovedAtIfNull: true,
      });
      expect(statusHistory.insert).toHaveBeenCalledWith(
        's-1',
        { fromStatus: 'pending_approval', toStatus: 'approved', reason: null, actorUserId: 'admin-1' },
        TRX,
      );
      expect(outbox.add.mock.calls[0]?.[1]).toMatchObject({
        contract: { type: 'seller.approved' },
        aggregateId: 's-1',
        payload: { sellerId: 's-1', userId: 'u-1', previousStatus: 'pending_approval' },
      });
    });

    it('unverified email → SELLER_EMAIL_NOT_VERIFIED, nothing written', async () => {
      const { service, sellers } = setup(makeSeller(SellerStatus.PENDING_APPROVAL), { emailVerified: false });
      expect(await codeOf(service.approve('s-1', 'admin-1'))).toBe('SELLER_EMAIL_NOT_VERIFIED');
      expect(sellers.transitionStatus).not.toHaveBeenCalled();
    });

    it('the wrong status wins over an unverified email: SELLER_INVALID_STATUS_TRANSITION', async () => {
      const { service } = setup(makeSeller(SellerStatus.APPROVED), { emailVerified: false });
      expect(await codeOf(service.approve('s-1', 'admin-1'))).toBe('SELLER_INVALID_STATUS_TRANSITION');
    });

    it('missing seller → SELLER_NOT_FOUND', async () => {
      const { service } = setup(undefined);
      expect(await codeOf(service.approve('s-1', 'admin-1'))).toBe('SELLER_NOT_FOUND');
    });

    it('lost race (0 rows updated) → SELLER_INVALID_STATUS_TRANSITION, no history, no event', async () => {
      const { service, sellers, statusHistory, outbox } = setup(makeSeller(SellerStatus.PENDING_APPROVAL));
      sellers.transitionStatus.mockResolvedValueOnce(undefined);
      expect(await codeOf(service.approve('s-1', 'admin-1'))).toBe('SELLER_INVALID_STATUS_TRANSITION');
      expect(statusHistory.insert).not.toHaveBeenCalled();
      expect(outbox.add).not.toHaveBeenCalled();
    });
  });

  it('reject stores the reason on the row and in the history, and publishes nothing', async () => {
    const { service, sellers, statusHistory, outbox } = setup(makeSeller(SellerStatus.PENDING_APPROVAL));
    await service.reject('s-1', 'Missing documents', 'admin-1');
    expect(sellers.transitionStatus).toHaveBeenCalledWith('s-1', 'pending_approval', 'rejected', TRX, {
      rejectionReason: 'Missing documents',
    });
    expect(statusHistory.insert).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({ reason: 'Missing documents' }),
      TRX,
    );
    expect(outbox.add).not.toHaveBeenCalled();
  });

  it('suspend publishes seller.suspended with the reason', async () => {
    const { service, outbox } = setup(makeSeller(SellerStatus.APPROVED));
    await service.suspend('s-1', 'Fake products', 'admin-1');
    expect(outbox.add.mock.calls[0]?.[1]).toMatchObject({
      contract: { type: 'seller.suspended' },
      payload: { sellerId: 's-1', userId: 'u-1', reason: 'Fake products' },
    });
  });

  it('reinstate publishes seller.approved with previousStatus = suspended', async () => {
    const { service, outbox } = setup(makeSeller(SellerStatus.SUSPENDED));
    await service.reinstate('s-1', null, 'admin-1');
    expect(outbox.add.mock.calls[0]?.[1]).toMatchObject({
      contract: { type: 'seller.approved' },
      payload: { previousStatus: 'suspended' },
    });
  });

  it('a transition on a missing seller (0 rows, no row) → SELLER_NOT_FOUND', async () => {
    const { service, sellers } = setup(undefined);
    sellers.transitionStatus.mockResolvedValueOnce(undefined);
    expect(await codeOf(service.suspend('s-1', 'reason', 'admin-1'))).toBe('SELLER_NOT_FOUND');
  });

  describe('changeCommissionRate', () => {
    it('locks the row, updates the rate and writes old/new to the history', async () => {
      const { service, sellers, commissionHistory } = setup(makeSeller(SellerStatus.APPROVED, '0.1000'));
      await service.changeCommissionRate('s-1', Rate.of('0.125'), 'admin-1');
      expect(sellers.findById).toHaveBeenCalledWith('s-1', TRX, { forUpdate: true });
      expect(commissionHistory.insert).toHaveBeenCalledWith(
        's-1',
        { oldRate: Rate.of('0.1'), newRate: Rate.of('0.125'), changedByUserId: 'admin-1' },
        TRX,
      );
    });

    it('the same rate in another spelling ("0.1" vs "0.1000") → COMMISSION_RATE_UNCHANGED', async () => {
      const { service, sellers } = setup(makeSeller(SellerStatus.APPROVED, '0.1000'));
      expect(await codeOf(service.changeCommissionRate('s-1', Rate.of('0.1'), 'admin-1'))).toBe(
        'COMMISSION_RATE_UNCHANGED',
      );
      expect(sellers.updateCommissionRate).not.toHaveBeenCalled();
    });
  });
});
