import { inject, injectable } from 'tsyringe';
import { UserRole } from '../../../lib/auth';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IPasswordHasher } from '../../../pkg/hashing';
import { UserStatus, VerificationPurpose } from '../enums';
import { type UserRepository } from '../repository/user.repository';
import { type IdentityEmailNotifier, recipientOf } from './identity-email.notifier';
import { type VerificationCodeService } from './verification-code.service';

/** Self-registered roles (their modules own the register endpoints, spec 03 §1). */
export type SelfRegisteredRole = typeof UserRole.CUSTOMER | typeof UserRole.SELLER;
/** Roles created by an admin invite (spec 03 UC-ID-7). */
export type InvitedRole = typeof UserRole.ADMIN | typeof UserRole.DELIVERY_AGENT;

const SELF_REGISTERED_ROLES: ReadonlySet<UserRole> = new Set([UserRole.CUSTOMER, UserRole.SELLER]);
const INVITED_ROLES: ReadonlySet<UserRole> = new Set([UserRole.ADMIN, UserRole.DELIVERY_AGENT]);

/** Public account creation (spec 03 §2). Both run in the caller's transaction. */
export interface IAccountService {
  /** Throws EMAIL_ALREADY_REGISTERED (via the `uq_users_email` mapping). */
  createPendingUser(
    input: { email: string; password: string; role: SelfRegisteredRole },
    trx: DbTransaction,
  ): Promise<{ userId: string }>;
  createInvitedUser(
    input: { email: string; role: InvitedRole },
    trx: DbTransaction,
  ): Promise<{ userId: string }>;
}

@injectable()
export class AccountService implements IAccountService {
  constructor(
    @inject(TOKENS.UserRepository) private readonly users: UserRepository,
    @inject(TOKENS.VerificationCodeService) private readonly codes: VerificationCodeService,
    @inject(TOKENS.IdentityEmailNotifier) private readonly notifier: IdentityEmailNotifier,
    @inject(TOKENS.PasswordHasher) private readonly hasher: IPasswordHasher,
  ) {}

  /** `email` must already be normalised (the callers' DTOs trim and lower-case it). */
  async createPendingUser(
    input: { email: string; password: string; role: SelfRegisteredRole },
    trx: DbTransaction,
  ): Promise<{ userId: string }> {
    // Guards against a cast at the call site: other roles never self-register.
    if (!SELF_REGISTERED_ROLES.has(input.role)) throw new Error(`Role ${input.role} cannot self-register`);
    const user = await this.users.insert(
      {
        email: input.email,
        passwordHash: await this.hasher.hash(input.password),
        role: input.role,
        status: UserStatus.PENDING_EMAIL_VERIFICATION,
      },
      trx,
    );
    const { otp } = await this.codes.issueOtp(user.id, VerificationPurpose.EMAIL_VERIFICATION, trx);
    await this.notifier.requestOtpEmail(trx, recipientOf(user), VerificationPurpose.EMAIL_VERIFICATION, otp);
    return { userId: user.id };
  }

  async createInvitedUser(
    input: { email: string; role: InvitedRole },
    trx: DbTransaction,
  ): Promise<{ userId: string }> {
    if (!INVITED_ROLES.has(input.role)) throw new Error(`Role ${input.role} cannot be invited`);
    const user = await this.users.insert(
      { email: input.email, passwordHash: null, role: input.role, status: UserStatus.INVITED },
      trx,
    );
    const { token, expiresAt } = await this.codes.issueInvite(user.id, trx);
    await this.notifier.requestInviteEmail(trx, recipientOf(user), user.role, token, expiresAt);
    return { userId: user.id };
  }
}
