import { container as rootContainer, type DependencyContainer } from 'tsyringe';
import { registerHealthModule } from './app/health';
import { registerIdentityModule } from './app/identity';
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

  registerHealthModule(container);
  registerIdentityModule(container);
  return container;
}

export function createWorkerContainer(infra: WorkerInfrastructure): DependencyContainer {
  const container = createCoreContainer(infra);
  container.register(TOKENS.EmailSender, { useValue: infra.emailSender });
  return container;
}
