import { container as rootContainer, type DependencyContainer } from 'tsyringe';
import { registerHealthModule } from './app/health';
import { TOKENS } from './lib/di';
import { type Infrastructure } from './infrastructure';

/**
 * Composition root: one child container per process (and per test app), so tests never share state.
 * Modules register themselves here as their phase lands.
 */
export function createContainer(infra: Infrastructure): DependencyContainer {
  const container = rootContainer.createChildContainer();
  container.register(TOKENS.Env, { useValue: infra.env });
  container.register(TOKENS.Logger, { useValue: infra.logger });
  container.register(TOKENS.Clock, { useValue: infra.clock });
  container.register(TOKENS.Database, { useValue: infra.db });
  container.register(TOKENS.TransactionRunner, { useValue: infra.db });
  container.register(TOKENS.PgErrorMapper, { useValue: infra.pgErrorMapper });
  container.register(TOKENS.Redis, { useValue: infra.redis });
  container.register(TOKENS.Cache, { useValue: infra.cache });
  container.register(TOKENS.MessageBroker, { useValue: infra.broker });
  container.register(TOKENS.JwtVerifier, { useValue: infra.jwtVerifier });
  container.register(TOKENS.RateLimiters, { useValue: infra.rateLimiters });
  container.register(TOKENS.OpenApiRegistry, { useValue: infra.openApi });

  registerHealthModule(container);
  return container;
}
