/**
 * realtime module (docs/spec/15-realtime.md): the Socket.IO gateway (`src/realtime.ts`) and the
 * worker's fan-out consumer. Owns no tables. Nothing depends on it: other modules reach clients by
 * publishing domain events, or through `lib/realtime`.
 * May call: customers, sellers, delivery (profile at connect), ordering (parties and statuses), support
 * (ticket access and states, spec 16).
 */
import { type DependencyContainer } from 'tsyringe';
import { TOKENS } from '../../lib/di';
import { type EventHandlerDefinition } from '../../lib/events';
import { type ISupportDirectory } from '../support';
import { REALTIME_FANOUT_QUEUE } from './constants';
import { RealtimeGateway, type RealtimeGatewayDeps } from './gateway/realtime-gateway';
import { ProfileRoomsService } from './service/profile-rooms.service';
import { FANOUT_EVENTS, RealtimeFanoutService } from './service/realtime-fanout.service';

export { REALTIME_PATH, RealtimeSignal } from './constants';
export { ConnectErrorCode, AckErrorCode } from './errors';
export { ConnectLimiter } from './service/connect-limiter';
export type { RealtimeGateway } from './gateway/realtime-gateway';

/** realtime process. Needs the customers, sellers, delivery and support lookups registered first. */
export function registerRealtimeGateway(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.ProfileRoomsService, ProfileRoomsService);
}

export function createRealtimeGateway(
  container: DependencyContainer,
  deps: Omit<RealtimeGatewayDeps, 'profileRooms' | 'support'>,
): RealtimeGateway {
  return new RealtimeGateway({
    ...deps,
    profileRooms: container.resolve<ProfileRoomsService>(TOKENS.ProfileRoomsService),
    support: container.resolve<ISupportDirectory>(TOKENS.SupportDirectory),
  });
}

/** worker process. Needs TOKENS.RealtimeEmitter, ordering and the support lookups registered. */
export function registerRealtimeWorker(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.RealtimeFanoutService, RealtimeFanoutService);
}

/** Consumer `realtime.fanout` (spec 15 UC-RT-2): stateless, no dedupe row (step 4). */
export function createRealtimeHandlers(container: DependencyContainer): EventHandlerDefinition[] {
  const fanout = container.resolve<RealtimeFanoutService>(TOKENS.RealtimeFanoutService);
  return [
    {
      name: REALTIME_FANOUT_QUEUE,
      events: FANOUT_EVENTS,
      stateless: true,
      handle: (envelope) => fanout.handle(envelope),
    },
  ];
}
