/**
 * identity module: authentication identity only (docs/spec/03-identity.md).
 * Owns tables: users, refresh_tokens, verification_codes. No other module reads or writes them.
 * Depends on no other module. This file is its only public surface.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { type Env } from '../../lib/config';
import { type ITransactionRunner } from '../../lib/db';
import { TOKENS } from '../../lib/di';
import { type PgErrorMapper } from '../../lib/error';
import { type OpenApiRegistry, validateDto } from '../../lib/http';
import { type JobDefinition } from '../../lib/jobs';
import { type RateLimiters } from '../../lib/middleware';
import { AdminController } from './controller/admin.controller';
import { AuthController } from './controller/auth.controller';
import { InviteAdminDto } from './dto/admin-request.dto';
import { emailAlreadyRegistered, registerIdentityConstraintErrors } from './errors';
import { RefreshTokenRepository } from './repository/refresh-token.repository';
import { UserRepository } from './repository/user.repository';
import { VerificationCodeRepository } from './repository/verification-code.repository';
import { identityRoutes } from './routes';
import { AccountService } from './service/account.service';
import { AuthService } from './service/auth.service';
import { IdentityCleanupService } from './service/identity-cleanup.service';
import { IdentityEmailNotifier } from './service/identity-email.notifier';
import { InvitationService } from './service/invitation.service';
import { TokenService } from './service/token.service';
import { UserAdminService } from './service/user-admin.service';
import { VerificationCodeService } from './service/verification-code.service';

export { UserStatus } from './enums';
export { IdentityErrorCode } from './errors';
/** Inject with `TOKENS.AccountService`. */
export type {
  IAccountService,
  SelfRegisteredRole,
  InvitedRole,
  UserSummary,
} from './service/account.service';

/**
 * What every process using identity needs: repositories, codes, invitations, cleanup.
 * Needs Database, TransactionRunner, Clock, Env, Outbox and SecretBox (no Redis, JWT or bcrypt).
 */
function registerIdentityCore(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.UserRepository, UserRepository);
  container.registerSingleton(TOKENS.RefreshTokenRepository, RefreshTokenRepository);
  container.registerSingleton(TOKENS.VerificationCodeRepository, VerificationCodeRepository);
  container.registerSingleton(TOKENS.VerificationCodeService, VerificationCodeService);
  container.registerSingleton(TOKENS.IdentityEmailNotifier, IdentityEmailNotifier);
  container.registerSingleton(TOKENS.InvitationService, InvitationService);
}

/** api process: everything, including HTTP. */
export function registerIdentityModule(container: DependencyContainer): void {
  registerIdentityCore(container);
  container.registerSingleton(TOKENS.TokenService, TokenService);
  container.registerSingleton(TOKENS.UserAdminService, UserAdminService);
  container.registerSingleton(TOKENS.AccountService, AccountService);
  container.registerSingleton(TOKENS.AuthService, AuthService);
  container.registerSingleton(TOKENS.AuthController, AuthController);
  container.registerSingleton(TOKENS.AdminController, AdminController);
  registerIdentityConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createIdentityRouter(container: DependencyContainer, basePath: string): Router {
  const authService = container.resolve<AuthService>(TOKENS.AuthService);
  return identityRoutes({
    auth: container.resolve<AuthController>(TOKENS.AuthController),
    admin: container.resolve<AdminController>(TOKENS.AdminController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    rateLimiters: container.resolve<RateLimiters>(TOKENS.RateLimiters),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
    emailOf: (userId) => authService.emailOf(userId),
  });
}

/** worker process: the `expired-codes-cleanup` job (architecture §6). */
export function createIdentityJobs(
  container: DependencyContainer,
  env: Pick<Env, 'CLEANUP_JOB_INTERVAL_MS'>,
): JobDefinition[] {
  registerIdentityCore(container);
  const cleanup = container.resolve(IdentityCleanupService);
  return [
    { name: 'expired-codes-cleanup', intervalMs: env.CLEANUP_JOB_INTERVAL_MS, run: () => cleanup.run() },
  ];
}

/**
 * seed-admin CLI (UC-ID-8): an invited admin plus the queued invite email. The token is never returned.
 * Throws VALIDATION_FAILED for a bad email and EMAIL_ALREADY_REGISTERED for an existing one.
 */
export async function inviteFirstAdmin(
  container: DependencyContainer,
  rawEmail: string,
): Promise<{ userId: string }> {
  registerIdentityCore(container);
  registerIdentityConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
  const { email } = await validateDto(InviteAdminDto, { email: rawEmail });
  const users = container.resolve<UserRepository>(TOKENS.UserRepository);
  if (await users.existsByEmail(email)) throw emailAlreadyRegistered();

  const invitations = container.resolve<InvitationService>(TOKENS.InvitationService);
  const transactions = container.resolve<ITransactionRunner>(TOKENS.TransactionRunner);
  const user = await transactions.run((trx) => invitations.invite(email, 'admin', trx));
  return { userId: user.id };
}
