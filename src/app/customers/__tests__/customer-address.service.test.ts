import { container as rootContainer } from 'tsyringe';
import { describe, expect, it, vi } from 'vitest';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type AddressFields, CustomerAddress } from '../model/customer-address.model';
import { CustomerAddressService } from '../service/customer-address.service';

const TRX = { isTransaction: true } as unknown as DbTransaction;
const NOW = new Date('2026-10-09T12:00:00.000Z');
const MAX = 3;
const FIELDS: AddressFields = {
  label: 'Home',
  recipientName: 'Mona Ali',
  recipientPhone: '+201001234567',
  governorateId: 'g-1',
  city: 'Cairo',
  area: 'Zamalek',
  street: '26th of July',
  building: '12',
  floor: null,
  apartment: null,
  landmark: null,
};

const address = (overrides: Partial<{ id: string; isDefault: boolean }> = {}) =>
  new CustomerAddress({
    id: 'a-1',
    customerId: 'c-1',
    isDefault: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...FIELDS,
    ...overrides,
  });

function setup(state: { count?: number; hasDefault?: boolean; current?: CustomerAddress } = {}) {
  const calls: string[] = [];
  const customers = {
    lockById: vi.fn(() => {
      calls.push('lock');
      return Promise.resolve(true);
    }),
  };
  const addresses = {
    countByCustomer: vi.fn(() => Promise.resolve(state.count ?? 0)),
    hasDefault: vi.fn(() => Promise.resolve(state.hasDefault ?? false)),
    clearDefault: vi.fn(() => {
      calls.push('clearDefault');
      return Promise.resolve();
    }),
    insert: vi.fn((_c: string, _f: AddressFields, isDefault: boolean) => {
      calls.push(`insert(default=${isDefault})`);
      return Promise.resolve(address({ isDefault }));
    }),
    findById: vi.fn(() => Promise.resolve(state.current)),
    update: vi.fn((_c: string, _id: string, changes: { isDefault?: boolean }) => {
      calls.push(`update(default=${String(changes.isDefault)})`);
      return Promise.resolve(state.current);
    }),
    softDelete: vi.fn(() => Promise.resolve(state.current !== undefined)),
  };
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.CustomerRepository, { useValue: customers });
  container.register(TOKENS.CustomerAddressRepository, { useValue: addresses });
  container.register(TOKENS.TransactionRunner, {
    useValue: { run: <T>(work: (trx: DbTransaction) => Promise<T>) => work(TRX) },
  });
  container.register(TOKENS.Env, { useValue: { CUSTOMER_MAX_ADDRESSES: MAX } });
  return { calls, addresses, service: container.resolve(CustomerAddressService) };
}

const errorCode = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (e: { code?: string }) => e.code,
  );

describe('customers CustomerAddressService (spec 04 UC-CU-2)', () => {
  describe('create', () => {
    it('the first address becomes the default even with isDefault=false', async () => {
      const { service, calls } = setup({ count: 0, hasDefault: false });
      await service.create('c-1', FIELDS, false);
      expect(calls).toEqual(['lock', 'insert(default=true)']);
    });

    it('with no live default (the default was deleted), the new address becomes it (C-3)', async () => {
      const { service, calls } = setup({ count: 2, hasDefault: false });
      await service.create('c-1', FIELDS, false);
      expect(calls).toEqual(['lock', 'insert(default=true)']);
    });

    it('isDefault=true with an existing default clears the old one first', async () => {
      const { service, calls } = setup({ count: 1, hasDefault: true });
      await service.create('c-1', FIELDS, true);
      expect(calls).toEqual(['lock', 'clearDefault', 'insert(default=true)']);
    });

    it('isDefault=false with an existing default keeps it', async () => {
      const { service, calls } = setup({ count: 1, hasDefault: true });
      await service.create('c-1', FIELDS, false);
      expect(calls).toEqual(['lock', 'insert(default=false)']);
    });

    it('at the limit → ADDRESS_LIMIT_REACHED, nothing written', async () => {
      const { service, calls } = setup({ count: MAX, hasDefault: true });
      expect(await errorCode(service.create('c-1', FIELDS, true))).toBe('ADDRESS_LIMIT_REACHED');
      expect(calls).toEqual(['lock']);
    });
  });

  describe('update', () => {
    it('isDefault=true on a non-default address moves the default', async () => {
      const { service, calls } = setup({ current: address({ isDefault: false }) });
      await service.update('c-1', 'a-1', { fields: {}, isDefault: true });
      expect(calls).toEqual(['lock', 'clearDefault', 'update(default=true)']);
    });

    it('isDefault=true on the default changes nothing about the default', async () => {
      const { service, calls } = setup({ current: address({ isDefault: true }) });
      await service.update('c-1', 'a-1', { fields: { label: 'Work' }, isDefault: true });
      expect(calls).toEqual(['lock', 'update(default=undefined)']);
    });

    it('isDefault=false on the default → DEFAULT_ADDRESS_UNSET_NOT_ALLOWED', async () => {
      const { service, calls } = setup({ current: address({ isDefault: true }) });
      expect(await errorCode(service.update('c-1', 'a-1', { fields: {}, isDefault: false }))).toBe(
        'DEFAULT_ADDRESS_UNSET_NOT_ALLOWED',
      );
      expect(calls).toEqual(['lock']);
    });

    it('isDefault=false on a non-default address is a no-op for the default', async () => {
      const { service, calls } = setup({ current: address({ isDefault: false }) });
      await service.update('c-1', 'a-1', { fields: { label: 'Work' }, isDefault: false });
      expect(calls).toEqual(['lock', 'update(default=undefined)']);
    });

    it('missing / deleted / another customer’s → ADDRESS_NOT_FOUND', async () => {
      const { service } = setup({ current: undefined });
      expect(await errorCode(service.update('c-1', 'a-1', { fields: { label: 'x' } }))).toBe(
        'ADDRESS_NOT_FOUND',
      );
    });
  });

  it('delete of a missing address → ADDRESS_NOT_FOUND', async () => {
    const { service } = setup({ current: undefined });
    expect(await errorCode(service.delete('c-1', 'a-1'))).toBe('ADDRESS_NOT_FOUND');
  });

  it('toSnapshot leaves out the label (spec 04 §2)', () => {
    expect(address().toSnapshot()).toEqual({
      recipientName: 'Mona Ali',
      recipientPhone: '+201001234567',
      governorateId: 'g-1',
      city: 'Cairo',
      area: 'Zamalek',
      street: '26th of July',
      building: '12',
      floor: null,
      apartment: null,
      landmark: null,
    });
  });
});
