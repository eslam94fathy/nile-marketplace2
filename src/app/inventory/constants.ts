import { FieldType, type ListSpec } from '../../lib/http';

export const INVENTORY_TABLES = {
  INVENTORY_ITEMS: 'inventory_items',
  INVENTORY_MOVEMENTS: 'inventory_movements',
  INVENTORY_RESERVATIONS: 'inventory_reservations',
} as const;

/** `inventory_movements.reference_type` of reservation movements: the reference is the order line. */
export const MOVEMENT_REFERENCE_ORDER_ITEM = 'order_item';

/** `reference_type` of `return_restock` movements: the reference is the return request (spec 07 §8). */
export const MOVEMENT_REFERENCE_RETURN = 'return';

/**
 * Stock history list (spec 06 §4.3): sort `-createdAt` only, no filters. Exported so the caller
 * (catalog's controller) parses the query without knowing inventory's columns.
 */
export const INVENTORY_MOVEMENT_LIST_SPEC: ListSpec = {
  fields: {
    createdAt: { column: 'created_at', type: FieldType.DATE, ops: [], sortable: true },
  },
  defaultSort: '-createdAt',
};
