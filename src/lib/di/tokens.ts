/**
 * DI tokens (CLAUDE.md §3). Infrastructure is injected through interfaces, so tests can replace it.
 * Modules add their own tokens in their phase (e.g. `IdentityService`).
 */
export const TOKENS = {
  Env: Symbol.for('Env'),
  Logger: Symbol.for('Logger'),
  Clock: Symbol.for('Clock'),
  Database: Symbol.for('Database'),
  TransactionRunner: Symbol.for('TransactionRunner'),
  PgErrorMapper: Symbol.for('PgErrorMapper'),
  Cache: Symbol.for('Cache'),
  Redis: Symbol.for('Redis'),
  MessageBroker: Symbol.for('MessageBroker'),
  Outbox: Symbol.for('Outbox'),
  JwtVerifier: Symbol.for('JwtVerifier'),
  RateLimiters: Symbol.for('RateLimiters'),
  OpenApiRegistry: Symbol.for('OpenApiRegistry'),

  // health module
  HealthService: Symbol.for('HealthService'),
  HealthController: Symbol.for('HealthController'),
} as const;
