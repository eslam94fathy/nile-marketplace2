import { container as rootContainer, type DependencyContainer } from 'tsyringe';
import { registerAuditModule, registerAuditRecorder, registerAuditWorker } from './app/audit';
import { registerCartModule } from './app/cart';
import { registerCatalogModule, registerCatalogProjections } from './app/catalog';
import { registerCustomersLookups, registerCustomersModule } from './app/customers';
import { registerDeliveryAgentLookups, registerDeliveryModule, registerDeliveryWorker } from './app/delivery';
import { registerFinanceModule, registerFinanceWorker } from './app/finance';
import { registerSellersLookups, registerSellersModule } from './app/sellers';
import { registerSupportModule, registerSupportWorker } from './app/support';
import { Dependency, registerHealthModule } from './app/health';
import { registerIdentityModule } from './app/identity';
import { registerInventoryModule } from './app/inventory';
import { registerMediaModule, registerMediaWorker } from './app/media';
import { registerNotificationsHttp, registerNotificationsModule } from './app/notifications';
import { registerOrderingModule, registerOrderingWorker } from './app/ordering';
import { registerPaymentsHttp, registerPaymentsModule } from './app/payments';
import { registerRealtimeGateway, registerRealtimeWorker } from './app/realtime';
import { TOKENS } from './lib/di';
import { Outbox } from './lib/events';
import { OpenApiRegistry } from './lib/http';
import {
  type ApiInfrastructure,
  type CoreInfrastructure,
  type RealtimeInfrastructure,
  type WorkerInfrastructure,
} from './infrastructure';

/**
 * Composition root: one child container per process (and per test app), so tests never share state.
 * Modules register themselves here as their phase lands.
 */
function createCoreContainer<E>(infra: CoreInfrastructure<E>): DependencyContainer {
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.Env, { useValue: infra.env });
  container.register(TOKENS.Logger, { useValue: infra.logger });
  container.register(TOKENS.Clock, { useValue: infra.clock });
  container.register(TOKENS.Database, { useValue: infra.db });
  container.register(TOKENS.TransactionRunner, { useValue: infra.db });
  container.register(TOKENS.PgErrorMapper, { useValue: infra.pgErrorMapper });
  container.register(TOKENS.MessageBroker, { useValue: infra.broker });
  container.register(TOKENS.SecretBox, { useValue: infra.secretBox });
  container.register(TOKENS.Outbox, { useValue: new Outbox(infra.clock) });
  // Every admin write records its audit row through this (spec 20 §2.2), in either process.
  registerAuditRecorder(container);
  return container;
}

export function createApiContainer(infra: ApiInfrastructure): DependencyContainer {
  const container = createCoreContainer(infra);
  container.register(TOKENS.Redis, { useValue: infra.redis });
  container.register(TOKENS.Cache, { useValue: infra.cache });
  container.register(TOKENS.JwtVerifier, { useValue: infra.jwtVerifier });
  container.register(TOKENS.SuspendedUsers, { useValue: infra.suspendedUsers });
  container.register(TOKENS.JwtSigner, { useValue: infra.jwtSigner });
  container.register(TOKENS.PasswordHasher, { useValue: infra.passwordHasher });
  container.register(TOKENS.RateLimiters, { useValue: infra.rateLimiters });
  container.register(TOKENS.OpenApiRegistry, { useValue: infra.openApi });
  container.register(TOKENS.PaymentGateway, { useValue: infra.paymentGateway });
  container.register(TOKENS.ObjectStorage, { useValue: infra.objectStorage });

  registerHealthModule(container, [
    { dependency: Dependency.POSTGRES, check: () => infra.db.ping() },
    { dependency: Dependency.REDIS, check: () => infra.cache.ping() },
    {
      dependency: Dependency.RABBITMQ,
      check: () =>
        infra.broker.isConnected() ? Promise.resolve() : Promise.reject(new Error('broker not connected')),
    },
    { dependency: Dependency.STORAGE, check: () => infra.objectStorage.ping() },
  ]);
  registerIdentityModule(container);
  // After identity: the audit-log views resolve actor emails through AccountService.
  registerAuditModule(container);
  registerMediaModule(container);
  registerCustomersModule(container);
  registerSellersModule(container);
  registerDeliveryModule(container);
  registerInventoryModule(container);
  registerCatalogModule(container);
  registerCartModule(container);
  registerPaymentsModule(container);
  registerPaymentsHttp(container);
  registerOrderingModule(container);
  // After sellers and delivery: finance resolves owners through their public APIs (FI-11).
  registerFinanceModule(container);
  // The notification centre endpoints (spec 13 §8.4).
  registerNotificationsHttp(container);
  // After ordering, media, customers and sellers: support reads them (spec 16 §1).
  registerSupportModule(container);
  return container;
}

export function createWorkerContainer(infra: WorkerInfrastructure): DependencyContainer {
  const container = createCoreContainer(infra);
  container.register(TOKENS.EmailSender, { useValue: infra.emailSender });
  container.register(TOKENS.PaymentGateway, { useValue: infra.paymentGateway });
  container.register(TOKENS.ObjectStorage, { useValue: infra.objectStorage });
  container.register(TOKENS.ImageProcessor, { useValue: infra.imageProcessor });

  // notifications.user-events resolves recipients through customers, sellers, delivery, ordering.
  registerNotificationsModule(container);
  registerCustomersLookups(container);
  registerDeliveryAgentLookups(container);
  // catalog.listing-projections reads seller statuses and stock (spec 06 UC-CA-7).
  registerSellersModule(container);
  registerInventoryModule(container);
  registerCatalogProjections(container);
  registerPaymentsModule(container);
  // ordering.shipment-updates and the order jobs (spec 09 §3.6–§3.10).
  registerOrderingWorker(container);
  // delivery.seller-order-updates and the assignment retry job (spec 11 DE-13).
  registerDeliveryWorker(container);
  // finance.ledger (spec 12 §1.2, FI-10).
  registerFinanceWorker(container);
  // audit-retention (spec 20 §2.4).
  registerAuditWorker(container);
  // media.processing and media-cleanup (spec 14 UC-ME-3, UC-ME-4).
  registerMediaWorker(container);
  // realtime.fanout (spec 15 UC-RT-2): ordering's directory is registered with the ordering worker.
  container.register(TOKENS.RealtimeEmitter, { useValue: infra.realtimeEmitter });
  container.register(TOKENS.PushSender, { useValue: infra.pushSender });
  registerRealtimeWorker(container);
  // support-jobs (spec 16 UC-SU-5).
  registerSupportWorker(container);
  return container;
}

/** The Socket.IO gateway (spec 15): health, the profile lookups and the gateway's rooms service. */
export function createRealtimeContainer(infra: RealtimeInfrastructure): DependencyContainer {
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.Env, { useValue: infra.env });
  container.register(TOKENS.Logger, { useValue: infra.logger });
  container.register(TOKENS.Clock, { useValue: infra.clock });
  container.register(TOKENS.Database, { useValue: infra.db });
  container.register(TOKENS.TransactionRunner, { useValue: infra.db });
  container.register(TOKENS.Cache, { useValue: infra.cache });
  // The health router documents itself; the gateway serves no API docs.
  container.register(TOKENS.OpenApiRegistry, { useValue: new OpenApiRegistry() });

  registerHealthModule(container, [
    { dependency: Dependency.POSTGRES, check: () => infra.db.ping() },
    { dependency: Dependency.REDIS, check: () => infra.cache.ping() },
  ]);
  registerCustomersLookups(container);
  registerSellersLookups(container);
  registerDeliveryAgentLookups(container);
  registerRealtimeGateway(container);
  return container;
}
