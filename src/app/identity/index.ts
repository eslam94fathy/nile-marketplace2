/**
 * identity module: authentication identity only (docs/spec/03-identity.md).
 * Owns tables: users, refresh_tokens, verification_codes. No other module reads or writes them.
 * Depends on no other module. This file is its only public surface.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { TOKENS } from '../../lib/di';
import { type PgErrorMapper } from '../../lib/error';
import { type OpenApiRegistry } from '../../lib/http';
import { type RateLimiters } from '../../lib/middleware';
import { AuthController } from './controller/auth.controller';
import { registerIdentityConstraintErrors } from './errors';
import { RefreshTokenRepository } from './repository/refresh-token.repository';
import { UserRepository } from './repository/user.repository';
import { identityRoutes } from './routes';
import { AccountService } from './service/account.service';
import { AuthService } from './service/auth.service';
import { IdentityEmailNotifier } from './service/identity-email.notifier';
import { TokenService } from './service/token.service';
import { VerificationCodeService } from './service/verification-code.service';
import { VerificationCodeRepository } from './repository/verification-code.repository';

export { UserStatus } from './enums';
export { IdentityErrorCode } from './errors';
/** Inject with `TOKENS.AccountService`. */
export type { IAccountService, SelfRegisteredRole, InvitedRole } from './service/account.service';

export function registerIdentityModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.UserRepository, UserRepository);
  container.registerSingleton(TOKENS.RefreshTokenRepository, RefreshTokenRepository);
  container.registerSingleton(TOKENS.VerificationCodeRepository, VerificationCodeRepository);
  container.registerSingleton(TOKENS.TokenService, TokenService);
  container.registerSingleton(TOKENS.VerificationCodeService, VerificationCodeService);
  container.registerSingleton(TOKENS.IdentityEmailNotifier, IdentityEmailNotifier);
  container.registerSingleton(TOKENS.AccountService, AccountService);
  container.registerSingleton(TOKENS.AuthService, AuthService);
  container.registerSingleton(TOKENS.AuthController, AuthController);
  registerIdentityConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createIdentityRouter(container: DependencyContainer, basePath: string): Router {
  const authService = container.resolve<AuthService>(TOKENS.AuthService);
  return identityRoutes({
    auth: container.resolve<AuthController>(TOKENS.AuthController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    rateLimiters: container.resolve<RateLimiters>(TOKENS.RateLimiters),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
    emailOf: (userId) => authService.emailOf(userId),
  });
}
