import { container as rootContainer } from 'tsyringe';
import { describe, expect, it, vi } from 'vitest';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { ListingProjectionService } from '../service/listing-projection.service';

const TRX = {} as DbTransaction;
const silent = {
  fatal: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
};

function setup(sellerStatus: string | null, product: object | null = { id: 'p1' }) {
  const products = {
    setSellerActive: vi.fn(() => Promise.resolve(3)),
    findLiveById: vi.fn(() => Promise.resolve(product)),
  };
  const variants = { findProductIdOf: vi.fn(() => Promise.resolve(product ? 'p1' : null)) };
  const projections = { recompute: vi.fn(() => Promise.resolve()) };
  const sellers = {
    getStatuses: vi.fn(() => Promise.resolve(sellerStatus ? [{ sellerId: 's1', status: sellerStatus }] : [])),
  };
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.ProductRepository, { useValue: products });
  container.register(TOKENS.ProductVariantRepository, { useValue: variants });
  container.register(TOKENS.ProductProjectionService, { useValue: projections });
  container.register(TOKENS.SellerDirectory, { useValue: sellers });
  container.register(TOKENS.Logger, { useValue: silent });
  return { products, projections, service: container.resolve(ListingProjectionService) };
}

describe('ListingProjectionService (spec 06 UC-CA-7)', () => {
  it.each([
    ['approved', true],
    ['suspended', false],
    ['pending_approval', false],
  ])('a seller in status %s projects seller_active = %s, whatever the event said', async (status, active) => {
    const { service, products } = setup(status);
    await service.syncSeller('s1', TRX);
    expect(products.setSellerActive).toHaveBeenCalledWith('s1', active, TRX);
  });

  it('an unknown seller is skipped', async () => {
    const { service, products } = setup(null);
    await service.syncSeller('s1', TRX);
    expect(products.setSellerActive).not.toHaveBeenCalled();
  });

  it('a stock event recomputes the live product under its lock, and skips a deleted one', async () => {
    const live = setup('approved');
    await live.service.syncStock('v1', TRX);
    expect(live.products.findLiveById).toHaveBeenCalledWith('p1', TRX, { forUpdate: true });
    expect(live.projections.recompute).toHaveBeenCalledWith({ id: 'p1' }, TRX);

    const gone = setup('approved', null);
    await gone.service.syncStock('v1', TRX);
    expect(gone.projections.recompute).not.toHaveBeenCalled();
  });
});
