import { type DependencyContainer } from 'tsyringe';
import { createCatalogHandlers } from './app/catalog';
import { createDeliveryHandlers } from './app/delivery';
import { createFinanceHandlers } from './app/finance';
import { createMediaHandlers } from './app/media';
import { createNotificationHandlers } from './app/notifications';
import { createOrderingHandlers } from './app/ordering';
import { createPaymentsHandlers } from './app/payments';
import { createRealtimeHandlers } from './app/realtime';
import { createSellersHandlers } from './app/sellers';
import { type EventHandlerDefinition } from './lib/events';

/**
 * Every event handler the worker runs, one per queue (docs/spec/02-events.md §2).
 * Modules export their handler definitions from their index.ts and are added here in their phase.
 */
export function createEventHandlers(container: DependencyContainer): EventHandlerDefinition[] {
  return [
    ...createNotificationHandlers(container),
    ...createCatalogHandlers(container),
    ...createPaymentsHandlers(container),
    ...createOrderingHandlers(container),
    ...createDeliveryHandlers(container),
    ...createFinanceHandlers(container),
    ...createMediaHandlers(container),
    ...createRealtimeHandlers(container),
    ...createSellersHandlers(container),
  ];
}
