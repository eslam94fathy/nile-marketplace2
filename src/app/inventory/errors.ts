import { AppError } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** inventory error codes (docs/spec/07-inventory.md §6). INSUFFICIENT_STOCK lands with `reserve` (P5). */
export const InventoryErrorCode = {
  STOCK_ADJUSTMENT_INVALID: 'STOCK_ADJUSTMENT_INVALID',
  INVENTORY_ITEM_NOT_FOUND: 'INVENTORY_ITEM_NOT_FOUND',
} as const;

const C = InventoryErrorCode;

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
