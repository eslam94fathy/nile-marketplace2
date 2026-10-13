import { container as rootContainer, type DependencyContainer } from 'tsyringe';
import { registerCartModule } from './app/cart';
import { registerCatalogModule, registerCatalogProjections } from './app/catalog';
import { registerCustomersModule } from './app/customers';
import { registerDeliveryModule, registerDeliveryWorker } from './app/delivery';
import { registerFinanceModule, registerFinanceWorker } from './app/finance';
import { registerSellersModule } from './app/sellers';
import { registerHealthModule } from './app/health';
import { registerIdentityModule } from './app/identity';
import { registerInventoryModule } from './app/inventory';
import { registerNotificationsModule } from './app/notifications';
import { registerOrderingModule, registerOrderingWorker } from './app/ordering';
import { registerPaymentsHttp, registerPaymentsModule } from './app/payments';
import { TOKENS } from './lib/di';
import { Outbox } from './lib/events';
import { type ApiInfrastructure, type CoreInfrastructure, type WorkerInfrastructure } from './infrastructure';

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
  return container;
}

export function createApiContainer(infra: ApiInfrastructure): DependencyContainer {
  const container = createCoreContainer(infra);
  container.register(TOKENS.Redis, { useValue: infra.redis });
  container.register(TOKENS.Cache, { useValue: infra.cache });
  container.register(TOKENS.JwtVerifier, { useValue: infra.jwtVerifier });
  container.register(TOKENS.JwtSigner, { useValue: infra.jwtSigner });
  container.register(TOKENS.PasswordHasher, { useValue: infra.passwordHasher });
  container.register(TOKENS.RateLimiters, { useValue: infra.rateLimiters });
  container.register(TOKENS.OpenApiRegistry, { useValue: infra.openApi });
  container.register(TOKENS.PaymentGateway, { useValue: infra.paymentGateway });

  registerHealthModule(container);
  registerIdentityModule(container);
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
  return container;
}

export function createWorkerContainer(infra: WorkerInfrastructure): DependencyContainer {
  const container = createCoreContainer(infra);
  container.register(TOKENS.EmailSender, { useValue: infra.emailSender });
  container.register(TOKENS.PaymentGateway, { useValue: infra.paymentGateway });

  registerNotificationsModule(container);
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
  return container;
}
