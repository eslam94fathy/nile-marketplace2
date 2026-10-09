import { container as rootContainer } from 'tsyringe';
import { describe, expect, it, vi } from 'vitest';
import { TOKENS } from '../../../lib/di';
import { type ILogger, type LogFields } from '../../../lib/logger';
import { Money, Rate } from '../../../lib/money';
import { GOVERNORATES_CACHE_KEY } from '../constants';
import { DeliverySettings } from '../model/delivery-settings.model';
import { Governorate } from '../model/governorate.model';
import { DeliveryReferenceService } from '../service/delivery-reference.service';
import { GovernorateService } from '../service/governorate.service';

const CAIRO = new Governorate({ id: 'g-cairo', code: 'EG-C', name: 'Cairo', deliveryFee: Money.of('50') });
const ASWAN = new Governorate({ id: 'g-aswan', code: 'EG-ASN', name: 'Aswan', deliveryFee: null });
const TTL = 3600;

class SpyLogger implements ILogger {
  readonly warnings: { message: string; fields?: LogFields }[] = [];
  fatal = () => undefined;
  error = () => undefined;
  warn = (message: string, fields?: LogFields) => void this.warnings.push({ message, fields });
  info = () => undefined;
  debug = () => undefined;
  child = () => this;
}

function setup() {
  const repository = {
    findAll: vi.fn(() => Promise.resolve([ASWAN, CAIRO])),
    updateDeliveryFee: vi.fn((): Promise<Governorate | undefined> => Promise.resolve(CAIRO)),
  };
  const store = new Map<string, string>();
  const cache = {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => Promise.resolve(void store.set(key, value))),
    setIfAbsent: vi.fn(),
    delete: vi.fn((key: string) => Promise.resolve(store.delete(key) ? 1 : 0)),
    ping: vi.fn(),
  };
  const settings = {
    get: vi.fn(() =>
      Promise.resolve(new DeliverySettings({ agentFeeShareRate: Rate.of('0.7'), updatedAt: new Date() })),
    ),
  };
  const logger = new SpyLogger();
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.GovernorateRepository, { useValue: repository });
  container.register(TOKENS.Cache, { useValue: cache });
  container.register(TOKENS.Env, { useValue: { GOVERNORATES_CACHE_TTL_SECONDS: TTL } });
  container.register(TOKENS.Logger, { useValue: logger });
  container.register(TOKENS.DeliverySettingsService, { useValue: settings });
  container.registerSingleton(TOKENS.GovernorateService, GovernorateService);
  return {
    repository,
    cache,
    store,
    logger,
    service: container.resolve<GovernorateService>(TOKENS.GovernorateService),
    reference: container.resolve(DeliveryReferenceService),
  };
}

const codes = (governorates: readonly Governorate[]) => governorates.map((g) => g.code);

describe('delivery GovernorateService (cache-aside, spec 11 DE-3)', () => {
  it('miss: reads the database and caches the list with the env TTL', async () => {
    const { service, repository, cache, store } = setup();

    expect(codes(await service.list())).toEqual(['EG-ASN', 'EG-C']);
    expect(repository.findAll).toHaveBeenCalledOnce();
    expect(cache.set).toHaveBeenCalledWith(GOVERNORATES_CACHE_KEY, expect.any(String), TTL);
    expect(JSON.parse(store.get(GOVERNORATES_CACHE_KEY) ?? '')).toEqual([
      { id: 'g-aswan', code: 'EG-ASN', name: 'Aswan', deliveryFee: null },
      { id: 'g-cairo', code: 'EG-C', name: 'Cairo', deliveryFee: '50.00' },
    ]);
  });

  it('hit: serves the cache without touching the database, fees intact', async () => {
    const { service, repository } = setup();
    await service.list();

    const second = await service.list();

    expect(repository.findAll).toHaveBeenCalledOnce();
    expect(second.map((g) => [g.code, g.deliveryFee?.toString() ?? null, g.isDeliverable])).toEqual([
      ['EG-ASN', null, false],
      ['EG-C', '50.00', true],
    ]);
  });

  it('a Redis failure or a corrupt entry falls back to the database with a warn', async () => {
    const { service, repository, cache, store, logger } = setup();
    cache.get.mockRejectedValueOnce(new Error('redis down'));
    cache.set.mockRejectedValueOnce(new Error('redis down'));
    expect(codes(await service.list())).toEqual(['EG-ASN', 'EG-C']);

    store.set(GOVERNORATES_CACHE_KEY, '{"not":"a list"}');
    expect(codes(await service.list())).toEqual(['EG-ASN', 'EG-C']);

    store.set(GOVERNORATES_CACHE_KEY, '[{"id":"x","code":"EG-C","name":"Cairo","deliveryFee":"oops"}]');
    expect(codes(await service.list())).toEqual(['EG-ASN', 'EG-C']);

    expect(repository.findAll).toHaveBeenCalledTimes(3);
    expect(logger.warnings.map((w) => w.message)).toEqual([
      'governorates cache read failed, reading the database',
      'governorates cache write failed',
      'governorates cache read failed, reading the database',
      'governorates cache read failed, reading the database',
    ]);
  });

  it('updateDeliveryFee deletes the cached list after the write', async () => {
    const { service, repository, store } = setup();
    await service.list();

    await service.updateDeliveryFee('g-cairo', Money.of('60'), 'admin-1');

    expect(repository.updateDeliveryFee).toHaveBeenCalledWith('g-cairo', Money.of('60'));
    expect(store.has(GOVERNORATES_CACHE_KEY)).toBe(false);
  });

  it('updateDeliveryFee still succeeds when the invalidation fails (bounded by the TTL)', async () => {
    const { service, cache, logger } = setup();
    cache.delete.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.updateDeliveryFee('g-cairo', null, 'admin-1')).resolves.toBe(CAIRO);
    expect(logger.warnings).toHaveLength(1);
  });

  it('updateDeliveryFee on an unknown id → 404 GOVERNORATE_NOT_FOUND, cache untouched', async () => {
    const { service, repository, cache } = setup();
    repository.updateDeliveryFee.mockResolvedValueOnce(undefined);

    await expect(service.updateDeliveryFee('missing', null, 'admin-1')).rejects.toMatchObject({
      code: 'GOVERNORATE_NOT_FOUND',
      httpStatus: 404,
    });
    expect(cache.delete).not.toHaveBeenCalled();
  });
});

describe('delivery public API (spec 11 §2)', () => {
  it('getGovernorateFees returns only the requested, known ids', async () => {
    const { reference } = setup();

    expect(await reference.getGovernorateFees(['g-cairo', 'g-aswan', 'unknown'])).toEqual([
      { id: 'g-aswan', name: 'Aswan', deliveryFee: null },
      { id: 'g-cairo', name: 'Cairo', deliveryFee: '50.00' },
    ]);
  });

  it('getGovernorateFees([]) does no lookup', async () => {
    const { reference, repository, cache } = setup();

    expect(await reference.getGovernorateFees([])).toEqual([]);
    expect(cache.get).not.toHaveBeenCalled();
    expect(repository.findAll).not.toHaveBeenCalled();
  });

  it('getAgentFeeShareRate returns the 4-decimal rate string', async () => {
    const { reference } = setup();

    expect(await reference.getAgentFeeShareRate()).toBe('0.7000');
  });
});
