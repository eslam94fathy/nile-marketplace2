import { randomUUID } from 'node:crypto';
import { container as rootContainer, type DependencyContainer } from 'tsyringe';
import { vi } from 'vitest';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ILogger, type LogFields } from '../../../lib/logger';
import { UserStatus } from '../enums';
import { RefreshToken } from '../model/refresh-token.model';
import { User, type UserProps } from '../model/user.model';
import { VerificationCode, type VerificationCodeProps } from '../model/verification-code.model';
import { type NewRefreshToken } from '../repository/refresh-token.repository';
import { type NewVerificationCode } from '../repository/verification-code.repository';

export const NOW = new Date('2026-10-08T12:00:00.000Z');
export const FAKE_TRX = { isTransaction: true } as unknown as DbTransaction;

export function makeUser(overrides: Partial<UserProps> = {}): User {
  return new User({
    id: randomUUID(),
    email: 'user@example.com',
    passwordHash: '$2b$10$hash',
    role: 'customer',
    status: UserStatus.ACTIVE,
    emailVerifiedAt: NOW,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

export function makeRefreshToken(
  overrides: Partial<ConstructorParameters<typeof RefreshToken>[0]> = {},
): RefreshToken {
  return new RefreshToken({
    id: randomUUID(),
    userId: randomUUID(),
    familyId: randomUUID(),
    tokenHash: 'a'.repeat(64),
    expiresAt: new Date(NOW.getTime() + 60_000),
    revokedAt: null,
    replacedById: null,
    userAgent: 'iPhone',
    createdAt: NOW,
    ...overrides,
  });
}

export function makeCode(overrides: Partial<VerificationCodeProps> = {}): VerificationCode {
  return new VerificationCode({
    id: randomUUID(),
    userId: randomUUID(),
    purpose: 'email_verification',
    codeHash: 'b'.repeat(64),
    expiresAt: new Date(NOW.getTime() + 60_000),
    attempts: 0,
    consumedAt: null,
    createdAt: NOW,
    ...overrides,
  });
}

export class SpyLogger implements ILogger {
  readonly entries: { level: string; message: string; fields?: LogFields }[] = [];
  fatal = (message: string, fields?: LogFields) => this.entries.push({ level: 'fatal', message, fields });
  error = (message: string, fields?: LogFields) => this.entries.push({ level: 'error', message, fields });
  warn = (message: string, fields?: LogFields) => this.entries.push({ level: 'warn', message, fields });
  info = (message: string, fields?: LogFields) => this.entries.push({ level: 'info', message, fields });
  debug = (message: string, fields?: LogFields) => this.entries.push({ level: 'debug', message, fields });
  child = () => this;
}

/** In-memory stand-ins, registered in a fresh child container per test (CLAUDE.md §12). */
export function createFakes() {
  const refreshTokens = {
    insert: vi.fn((token: NewRefreshToken) =>
      Promise.resolve(makeRefreshToken({ ...token, id: randomUUID(), revokedAt: null, replacedById: null })),
    ),
    findByHash: vi.fn((): Promise<RefreshToken | undefined> => Promise.resolve(undefined)),
    revokeIfActive: vi.fn(() => Promise.resolve(true)),
    setReplacedBy: vi.fn(() => Promise.resolve()),
    revokeFamily: vi.fn(() => Promise.resolve(1)),
    revokeAllForUser: vi.fn(() => Promise.resolve(2)),
  };
  const users = {
    findById: vi.fn((): Promise<User | undefined> => Promise.resolve(undefined)),
  };
  const codes = {
    insert: vi.fn((code: NewVerificationCode) => Promise.resolve(makeCode({ ...code }))),
    findLatestActive: vi.fn((): Promise<VerificationCode | undefined> => Promise.resolve(undefined)),
    findUnconsumedInviteByHash: vi.fn((): Promise<VerificationCode | undefined> =>
      Promise.resolve(undefined),
    ),
    incrementAttempts: vi.fn(() => Promise.resolve()),
    consume: vi.fn(() => Promise.resolve(true)),
    consumeAllActive: vi.fn(() => Promise.resolve(0)),
  };
  const signer = {
    signAccessToken: vi.fn(() =>
      Promise.resolve({ token: 'signed.access.token', expiresAt: new Date(NOW.getTime() + 900_000) }),
    ),
  };
  const outbox = {
    add: vi.fn((_trx: DbTransaction, _event: unknown) => Promise.resolve()),
    addMany: vi.fn((_trx: DbTransaction, _events: unknown[]) => Promise.resolve()),
  };
  const logger = new SpyLogger();
  const transactions = { run: <T>(work: (trx: DbTransaction) => Promise<T>) => work(FAKE_TRX) };
  const clock = { now: () => new Date(NOW) };

  const container: DependencyContainer = rootContainer.createChildContainer();
  container.register(TOKENS.RefreshTokenRepository, { useValue: refreshTokens });
  container.register(TOKENS.UserRepository, { useValue: users });
  container.register(TOKENS.VerificationCodeRepository, { useValue: codes });
  container.register(TOKENS.JwtSigner, { useValue: signer });
  container.register(TOKENS.Outbox, { useValue: outbox });
  container.register(TOKENS.Logger, { useValue: logger });
  container.register(TOKENS.TransactionRunner, { useValue: transactions });
  container.register(TOKENS.Clock, { useValue: clock });
  return { container, refreshTokens, users, codes, signer, outbox, logger };
}
