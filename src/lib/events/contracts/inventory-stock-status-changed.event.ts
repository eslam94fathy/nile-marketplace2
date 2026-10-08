import { defineEvent } from './define-event';

/** Publisher: inventory (only when sellable crosses 0). Consumer: catalog. */
export interface InventoryStockStatusChangedPayload {
  variantId: string;
  inStock: boolean;
}

export const InventoryStockStatusChanged = defineEvent<InventoryStockStatusChangedPayload>(
  'inventory.stock_status_changed',
  1,
  'inventory_item',
);
