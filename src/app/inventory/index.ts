/**
 * inventory module (docs/spec/07-inventory.md): stock per variant and the audit trail of every
 * movement. Reservations (reserve / release / commit) land with checkout in Phase 5 (IN-1).
 * Owns tables: inventory_items, inventory_movements (and inventory_reservations from P5).
 * No other module reads or writes them. May call: nobody. No HTTP routes: the seller stock
 * endpoints live in catalog, which knows the variant's owner. This file is its only public surface.
 */
import { type DependencyContainer } from 'tsyringe';
import { TOKENS } from '../../lib/di';
import { InventoryItemRepository } from './repository/inventory-item.repository';
import { InventoryMovementRepository } from './repository/inventory-movement.repository';
import { InventoryService } from './service/inventory.service';

export { MovementType } from './enums';
export { InventoryErrorCode } from './errors';
export { INVENTORY_MOVEMENT_LIST_SPEC } from './constants';
export type { StockDto } from './model/inventory-item.model';
export type { InventoryMovement } from './model/inventory-movement.model';
/** Inject with `TOKENS.InventoryService`. */
export type { IInventoryService } from './service/inventory.service';

/** api and worker (catalog calls it from requests and from its listing-projection consumer). */
export function registerInventoryModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.InventoryItemRepository, InventoryItemRepository);
  container.registerSingleton(TOKENS.InventoryMovementRepository, InventoryMovementRepository);
  container.registerSingleton(TOKENS.InventoryService, InventoryService);
}
