/**
 * inventory module (docs/spec/07-inventory.md): stock per variant and the audit trail of every
 * movement, and the reservations ordering holds for order lines (reserve / release / commit, IN-5),
 * plus the restock of returned units (spec 07 §8, called by returns).
 * Owns tables: inventory_items, inventory_movements, inventory_reservations.
 * No other module reads or writes them. May call: nobody. No HTTP routes: the seller stock
 * endpoints live in catalog, which knows the variant's owner. This file is its only public surface.
 */
import { type DependencyContainer } from 'tsyringe';
import { TOKENS } from '../../lib/di';
import { InventoryItemRepository } from './repository/inventory-item.repository';
import { InventoryMovementRepository } from './repository/inventory-movement.repository';
import { InventoryReservationRepository } from './repository/inventory-reservation.repository';
import { InventoryService } from './service/inventory.service';

export { MovementType, ReservationStatus } from './enums';
export { InventoryErrorCode, insufficientStock } from './errors';
export type { ShortLine } from './errors';
export { INVENTORY_MOVEMENT_LIST_SPEC } from './constants';
export type { StockDto } from './model/inventory-item.model';
export type { InventoryMovement } from './model/inventory-movement.model';
export type { ReleaseLine, ReserveLine, RestockLine } from './model/inventory-reservation.model';
/** Inject with `TOKENS.InventoryService`. */
export type { IInventoryService } from './service/inventory.service';

/** api and worker (catalog calls it from requests and from its listing-projection consumer). */
export function registerInventoryModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.InventoryItemRepository, InventoryItemRepository);
  container.registerSingleton(TOKENS.InventoryMovementRepository, InventoryMovementRepository);
  container.registerSingleton(TOKENS.InventoryReservationRepository, InventoryReservationRepository);
  container.registerSingleton(TOKENS.InventoryService, InventoryService);
}
