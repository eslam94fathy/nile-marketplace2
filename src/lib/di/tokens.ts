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
  SecretBox: Symbol.for('SecretBox'),
  JwtSigner: Symbol.for('JwtSigner'),
  PasswordHasher: Symbol.for('PasswordHasher'),
  EmailSender: Symbol.for('EmailSender'),
  JwtVerifier: Symbol.for('JwtVerifier'),
  RateLimiters: Symbol.for('RateLimiters'),
  OpenApiRegistry: Symbol.for('OpenApiRegistry'),

  // identity module
  UserRepository: Symbol.for('UserRepository'),
  RefreshTokenRepository: Symbol.for('RefreshTokenRepository'),
  VerificationCodeRepository: Symbol.for('VerificationCodeRepository'),
  TokenService: Symbol.for('TokenService'),
  VerificationCodeService: Symbol.for('VerificationCodeService'),
  IdentityEmailNotifier: Symbol.for('IdentityEmailNotifier'),
  /** Public API of identity (spec 03 §2), injected into other modules. */
  AccountService: Symbol.for('AccountService'),
  AuthService: Symbol.for('AuthService'),
  AuthController: Symbol.for('AuthController'),
  InvitationService: Symbol.for('InvitationService'),
  UserAdminService: Symbol.for('UserAdminService'),
  AdminController: Symbol.for('AdminController'),

  // notifications module
  NotificationLogRepository: Symbol.for('NotificationLogRepository'),
  EmailNotificationService: Symbol.for('EmailNotificationService'),

  // health module
  HealthService: Symbol.for('HealthService'),
  HealthController: Symbol.for('HealthController'),
} as const;
