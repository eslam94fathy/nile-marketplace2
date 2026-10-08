import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { randomToken } from '../../../pkg/crypto';
import { type IPasswordHasher } from '../../../pkg/hashing';
import { type OtpPurpose, UserStatus, VerificationPurpose } from '../enums';
import {
  accountSuspended,
  emailNotVerified,
  invalidCredentials,
  invalidCurrentPassword,
  invalidInviteToken,
  invalidOtp,
  invalidRefreshToken,
  passwordUnchanged,
} from '../errors';
import { type User } from '../model/user.model';
import { type UserRepository } from '../repository/user.repository';
import { type IdentityEmailNotifier, recipientOf } from './identity-email.notifier';
import { type SessionTokens, type TokenService } from './token.service';
import { type VerificationCodeService } from './verification-code.service';

export interface Session {
  user: User;
  tokens: SessionTokens;
}

/** Inputs arrive validated and normalised (emails trimmed and lower-cased) by the DTOs. */
@injectable()
export class AuthService {
  /** Compared against when there is no real hash, so timing doesn't reveal the account (UC-ID-3). */
  private dummyHash: Promise<string> | undefined;

  constructor(
    @inject(TOKENS.UserRepository) private readonly users: UserRepository,
    @inject(TOKENS.TokenService) private readonly tokens: TokenService,
    @inject(TOKENS.VerificationCodeService) private readonly codes: VerificationCodeService,
    @inject(TOKENS.IdentityEmailNotifier) private readonly notifier: IdentityEmailNotifier,
    @inject(TOKENS.PasswordHasher) private readonly hasher: IPasswordHasher,
    @inject(TOKENS.TransactionRunner) private readonly transactions: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  /** UC-ID-1. A wrong code's attempt is committed before INVALID_OTP is thrown. */
  async verifyEmail(email: string, otp: string): Promise<Session> {
    const session = await this.transactions.run(async (trx): Promise<Session | undefined> => {
      const user = await this.users.findByEmail(email, trx, { forUpdate: true });
      if (!user?.isPendingEmailVerification()) return undefined;
      const check = await this.codes.checkOtp(user.id, VerificationPurpose.EMAIL_VERIFICATION, otp, trx);
      if (!check.ok || !(await this.codes.consume(check.codeId, trx))) return undefined;

      const active = await this.users.transitionStatus(
        user.id,
        [UserStatus.PENDING_EMAIL_VERIFICATION],
        UserStatus.ACTIVE,
        trx,
        { emailVerifiedAt: this.clock.now() },
      );
      if (!active) return undefined;
      return { user: active, tokens: await this.tokens.startSession(active, null, trx) };
    });
    if (!session) throw invalidOtp();
    return session;
  }

  /** UC-ID-2. Silent no-op unless the account is pending verification and outside the cooldown. */
  resendVerificationOtp(email: string): Promise<void> {
    return this.sendOtpIfAllowed(
      email,
      VerificationPurpose.EMAIL_VERIFICATION,
      UserStatus.PENDING_EMAIL_VERIFICATION,
    );
  }

  /** UC-ID-6 forgot. Silent no-op unless the account is active and outside the cooldown. */
  forgotPassword(email: string): Promise<void> {
    return this.sendOtpIfAllowed(email, VerificationPurpose.PASSWORD_RESET, UserStatus.ACTIVE);
  }

  /** UC-ID-3. Status errors only after a correct password, so they don't enable enumeration. */
  async login(email: string, password: string, deviceName: string | null): Promise<Session> {
    const user = await this.users.findByEmail(email);
    const hash = user?.passwordHash ?? (await this.getDummyHash());
    const matches = await this.hasher.verify(password, hash);
    if (!user?.passwordHash || !matches) throw invalidCredentials();
    if (user.isPendingEmailVerification()) throw emailNotVerified();
    if (user.isSuspended()) throw accountSuspended();
    if (!user.isActive()) throw invalidCredentials();

    const tokens = await this.transactions.run(async (trx) => {
      await this.users.touchLastLogin(user.id, this.clock.now(), trx);
      return this.tokens.startSession(user, deviceName, trx);
    });
    return { user, tokens };
  }

  /** UC-ID-4. */
  refresh(refreshToken: string): Promise<Session> {
    return this.tokens.rotate(refreshToken);
  }

  /** UC-ID-5. Always succeeds, even for an unknown token. */
  logout(refreshToken: string): Promise<void> {
    return this.tokens.endSession(refreshToken);
  }

  /** UC-ID-6 reset: new password, code consumed, every session revoked. */
  async resetPassword(email: string, otp: string, newPassword: string): Promise<void> {
    // Hashed before the transaction: bcrypt is slow and must not hold row locks.
    const passwordHash = await this.hasher.hash(newPassword);
    const done = await this.transactions.run(async (trx): Promise<boolean> => {
      const user = await this.users.findByEmail(email, trx, { forUpdate: true });
      if (!user?.isActive()) return false;
      const check = await this.codes.checkOtp(user.id, VerificationPurpose.PASSWORD_RESET, otp, trx);
      if (!check.ok || !(await this.codes.consume(check.codeId, trx))) return false;

      await this.users.updatePasswordHash(user.id, passwordHash, trx);
      await this.tokens.revokeAllSessions(user.id, trx);
      return true;
    });
    if (!done) throw invalidOtp();
  }

  /** UC-ID-7 accept: sets the password, activates the account (the link proved the email), logs in. */
  async acceptInvite(token: string, password: string): Promise<Session> {
    const passwordHash = await this.hasher.hash(password);
    return this.transactions.run(async (trx) => {
      const invite = await this.codes.findUsableInvite(token, trx);
      if (!invite || !(await this.codes.consume(invite.id, trx))) throw invalidInviteToken();

      const user = await this.users.transitionStatus(
        invite.userId,
        [UserStatus.INVITED],
        UserStatus.ACTIVE,
        trx,
        { passwordHash, emailVerifiedAt: this.clock.now() },
      );
      if (!user) throw invalidInviteToken();
      return { user, tokens: await this.tokens.startSession(user, null, trx) };
    });
  }

  /** Spec 03 §4.9b: keeps the caller's session (the family of `refreshToken`), revokes the others. */
  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string; refreshToken: string },
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user?.isActive() || !user.passwordHash) throw invalidRefreshToken();
    if (!(await this.hasher.verify(input.currentPassword, user.passwordHash))) throw invalidCurrentPassword();
    if (input.newPassword === input.currentPassword) throw passwordUnchanged();

    const currentHash = user.passwordHash;
    const newHash = await this.hasher.hash(input.newPassword);
    await this.transactions.run(async (trx) => {
      const familyId = await this.tokens.activeFamilyOf(input.refreshToken, userId, trx);
      if (!familyId) throw invalidRefreshToken();
      // Conditional on the verified hash: a concurrent change makes this one fail.
      if (!(await this.users.replacePasswordHash(userId, currentHash, newHash, trx))) {
        throw invalidCurrentPassword();
      }
      await this.tokens.revokeAllSessions(userId, trx, { exceptFamilyId: familyId });
    });
  }

  /** For the change-password rate limit, which counts per account email (spec 03 §4.9b). */
  async emailOf(userId: string): Promise<string | undefined> {
    return (await this.users.findById(userId))?.email;
  }

  /** Cooldown is re-checked under the user's row lock, so concurrent requests send one code. */
  private async sendOtpIfAllowed(
    email: string,
    purpose: OtpPurpose,
    requiredStatus: UserStatus,
  ): Promise<void> {
    await this.transactions.run(async (trx) => {
      const user = await this.users.findByEmail(email, trx, { forUpdate: true });
      if (user?.status !== requiredStatus) return;
      if (!(await this.codes.isOutsideCooldown(user.id, purpose, trx))) return;
      const { otp } = await this.codes.issueOtp(user.id, purpose, trx);
      await this.notifier.requestOtpEmail(trx, recipientOf(user), purpose, otp);
    });
  }

  /** Same cost factor as real hashes (from env via the hasher), computed once. */
  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hasher.hash(randomToken());
    return this.dummyHash;
  }
}
