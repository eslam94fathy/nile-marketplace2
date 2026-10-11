import { describe, expect, it } from 'vitest';
import { HTTP_STATUS } from '../../../lib/http';
import { InventoryErrorCode, insufficientStock } from '../errors';

describe('insufficientStock (spec 07 §6, IN-4)', () => {
  it('is a 409 with one detail per short variant', () => {
    const error = insufficientStock([
      { variantId: 'variant-1', available: 3 },
      { variantId: 'variant-2', available: 0 },
    ]);

    expect(error.code).toBe(InventoryErrorCode.INSUFFICIENT_STOCK);
    expect(error.httpStatus).toBe(HTTP_STATUS.CONFLICT);
    expect(error.isOperational).toBe(true);
    expect(error.details).toEqual([
      { field: 'variantId', value: 'variant-1', constraint: 'available', message: 'available: 3' },
      { field: 'variantId', value: 'variant-2', constraint: 'available', message: 'available: 0' },
    ]);
  });

  it('creates a new instance on every call', () => {
    expect(insufficientStock([])).not.toBe(insufficientStock([]));
  });
});
