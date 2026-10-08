/**
 * identity module: authentication identity only (docs/spec/03-identity.md).
 * Owns tables: users, refresh_tokens, verification_codes. No other module reads or writes them.
 * Depends on no other module. This file is its only public surface.
 */
import { type DependencyContainer } from 'tsyringe';
import { TOKENS } from '../../lib/di';
import { type PgErrorMapper } from '../../lib/error';
import { registerIdentityConstraintErrors } from './errors';
import { RefreshTokenRepository } from './repository/refresh-token.repository';
import { UserRepository } from './repository/user.repository';
import { VerificationCodeRepository } from './repository/verification-code.repository';
import { IdentityEmailNotifier } from './service/identity-email.notifier';
import { TokenService } from './service/token.service';
import { VerificationCodeService } from './service/verification-code.service';

export { UserStatus } from './enums';
export { IdentityErrorCode } from './errors';

export function registerIdentityModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.UserRepository, UserRepository);
  container.registerSingleton(TOKENS.RefreshTokenRepository, RefreshTokenRepository);
  container.registerSingleton(TOKENS.VerificationCodeRepository, VerificationCodeRepository);
  container.registerSingleton(TOKENS.TokenService, TokenService);
  container.registerSingleton(TOKENS.VerificationCodeService, VerificationCodeService);
  container.registerSingleton(TOKENS.IdentityEmailNotifier, IdentityEmailNotifier);
  registerIdentityConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
}
