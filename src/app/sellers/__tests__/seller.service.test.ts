import { container as rootContainer } from 'tsyringe';
import { describe, expect, it, vi } from 'vitest';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Rate } from '../../../lib/money';
import { SellerStatus } from '../enums';
import { Seller } from '../model/seller.model';
import { SellerService } from '../service/seller.service';

const TRX = { isTransaction: true } as unknown as DbTransaction;
const NOW = new Date('2026-10-09T12:00:00.000Z');
const PICKUP = {
  governorateId: 'g-1',
  city: 'Cairo',
  area: 'Nasr City',
  street: 'Abbas El Akkad',
  building: '5',
  landmark: null,
};

const seller = (status: SellerStatus = SellerStatus.PENDING_APPROVAL) =>
  new Seller({
    id: 's-1',
    userId: 'u-1',
    businessName: 'Nile Crafts',
    contactPhone: '+201001234567',
    pickup: PICKUP,
    status,
    commissionRate: Rate.of('0.12'),
    rejectionReason: null,
    approvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

function setup() {
  const calls: string[] = [];
  const accounts = {
    hashPassword: vi.fn(() => {
      calls.push('hashPassword');
      return Promise.resolve('hash');
    }),
    createPendingUser: vi.fn(() => {
      calls.push('createPendingUser');
      return Promise.resolve({ userId: 'u-1' });
    }),
    getUsersByIds: vi.fn(() => Promise.resolve([{ id: 'u-1', email: 'shop@example.com' }])),
  };
  const sellers = {
    insert: vi.fn(() => {
      calls.push('insertSeller');
      return Promise.resolve(seller());
    }),
    findByUserId: vi.fn(() => Promise.resolve(seller(SellerStatus.REJECTED))),
    transitionStatus: vi.fn((): Promise<Seller | undefined> => {
      calls.push('transition');
      return Promise.resolve(seller());
    }),
  };
  const history = {
    insert: vi.fn(() => {
      calls.push('history');
      return Promise.resolve();
    }),
  };
  const settings = {
    get: vi.fn(() => {
      calls.push('readDefaultRate');
      return Promise.resolve({ defaultCommissionRate: Rate.of('0.12'), updatedAt: NOW });
    }),
  };
  const transactions = {
    run: <T>(work: (trx: DbTransaction) => Promise<T>) => {
      calls.push('begin');
      return work(TRX).then((result) => {
        calls.push('commit');
        return result;
      });
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() };
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.AccountService, { useValue: accounts });
  container.register(TOKENS.SellerRepository, { useValue: sellers });
  container.register(TOKENS.SellerStatusHistoryRepository, { useValue: history });
  container.register(TOKENS.SellerSettingsRepository, { useValue: settings });
  container.register(TOKENS.TransactionRunner, { useValue: transactions });
  container.register(TOKENS.Logger, { useValue: { ...logger, child: () => logger } });
  return { calls, sellers, history, settings, service: container.resolve(SellerService) };
}

describe('sellers SellerService', () => {
  it('register: hashes before the transaction, then user → default rate → seller → history row', async () => {
    const { service, calls, sellers, history } = setup();

    await service.register({
      email: 'shop@example.com',
      password: 'long enough',
      businessName: 'Nile Crafts',
      contactPhone: '+201001234567',
      pickup: PICKUP,
    });

    expect(calls).toEqual([
      'hashPassword',
      'begin',
      'createPendingUser',
      'readDefaultRate',
      'insertSeller',
      'history',
      'commit',
    ]);
    expect(sellers.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: SellerStatus.PENDING_APPROVAL, commissionRate: Rate.of('0.12') }),
      TRX,
    );
    expect(history.insert).toHaveBeenCalledWith(
      's-1',
      { fromStatus: null, toStatus: SellerStatus.PENDING_APPROVAL, reason: null, actorUserId: 'u-1' },
      TRX,
    );
  });

  it('reapply: a conditional rejected → pending_approval with a history row', async () => {
    const { service, calls, sellers, history } = setup();

    await service.reapply('u-1');

    expect(sellers.transitionStatus).toHaveBeenCalledWith(
      's-1',
      SellerStatus.REJECTED,
      SellerStatus.PENDING_APPROVAL,
      TRX,
    );
    expect(history.insert).toHaveBeenCalledWith(
      's-1',
      { fromStatus: 'rejected', toStatus: 'pending_approval', reason: null, actorUserId: 'u-1' },
      TRX,
    );
    expect(calls).toEqual(['begin', 'transition', 'history', 'commit']);
  });

  it('reapply when not rejected → SELLER_INVALID_STATUS_TRANSITION, no history row', async () => {
    const { service, sellers, history } = setup();
    sellers.transitionStatus.mockResolvedValueOnce(undefined);

    await expect(service.reapply('u-1')).rejects.toMatchObject({
      code: 'SELLER_INVALID_STATUS_TRANSITION',
      httpStatus: 409,
    });
    expect(history.insert).not.toHaveBeenCalled();
  });

  it('a seller token without a profile → FORBIDDEN', async () => {
    const { service, sellers } = setup();
    sellers.findByUserId.mockResolvedValueOnce(undefined as unknown as Seller);

    await expect(service.getProfile('u-x')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
