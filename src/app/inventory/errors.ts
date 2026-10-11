import { AppError, type ErrorDetail } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/**
 * inventory error codes (docs/spec/07-inventory.md §6). INSUFFICIENT_STOCK is also thrown by cart's
 * soft stock check (IN-4), so it's exported before `reserve` lands (P5).
 */
export const InventoryErrorCode = {
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  STOCK_ADJUSTMENT_INVALID: 'STOCK_ADJUSTMENT_INVALID',
  INVENTORY_ITEM_NOT_FOUND: 'INVENTORY_ITEM_NOT_FOUND',
} as const;

const C = InventoryErrorCode;

export interface ShortLine {
  variantId: string;
  /** Sellable quantity at the time of the check. */
  available: number;
}

/** One detail per short variant, so the client sees every short line at once (spec 07 §2, spec 01 §2). */
export const insufficientStock = (shortLines: readonly ShortLine[]) =>
  new AppError(C.INSUFFICIENT_STOCK, 'Not enough stock for one or more items', HTTP_STATUS.CONFLICT, {
    details: shortLines.map((line): ErrorDetail => ({
      field: 'variantId',
      value: line.variantId,
      constraint: 'available',
      message: `available: ${line.available}`,
    })),
  });

export const stockAdjustmentInvalid = () =>
  new AppError(
    C.STOCK_ADJUSTMENT_INVALID,
    'This adjustment would make stock negative or lower than the reserved quantity',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
  );

/** Every variant gets its stock row in the same transaction, so a missing one is a bug. */
export const inventoryItemNotFound = (variantId: string) =>
  new AppError(C.INVENTORY_ITEM_NOT_FOUND, 'Internal server error', HTTP_STATUS.INTERNAL_SERVER_ERROR, {
    isOperational: false,
    cause: new Error(`variant ${variantId} has no inventory item`),
  });
