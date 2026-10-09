import { inject, injectable } from 'tsyringe';
import { UserRole } from '../../../lib/auth';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IPasswordHasher } from '../../../pkg/hashing';
import { UserStatus, VerificationPurpose } from '../enums';
import { type UserRepository } from '../repository/user.repository';
import { type IdentityEmailNotifier, recipientOf } from './identity-email.notifier';
import { type InvitationService, type InvitedRole } from './invitation.service';
import { type UserAdminService } from './user-admin.service';
import { type VerificationCodeService } from './verification-code.service';

/** Self-registered roles (their modules own the register endpoints, spec 03 §1). */
export type SelfRegisteredRole = typeof UserRole.CUSTOMER | typeof UserRole.SELLER;
export type { InvitedRole } from './invitation.service';

const SELF_REGISTERED_ROLES: ReadonlySet<UserRole> = new Set([UserRole.CUSTOMER, UserRole.SELLER]);

declare const passwordHashBrand: unique symbol;
/** A bcrypt hash made by `hashPassword`. Branded so a caller can't pass a plain password by mistake. */
export type PasswordHash = string & { readonly [passwordHashBrand]: true };

/** What other modules see of a user (spec 03 §2). */
export interface UserSummary {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: Date | null;
}

/** Public API of identity (spec 03 §2). Every write runs in the caller's transaction. */
export interface IAccountService {
  /** bcrypt is slow on purpose: call it before opening the transaction (spec 03 I-4, I-10). */
  hashPassword(password: string): Promise<PasswordHash>;
  /** Throws EMAIL_ALREADY_REGISTERED (via the `uq_users_email` mapping). */
  createPendingUser(
    input: { email: string; passwordHash: PasswordHash; role: SelfRegisteredRole },
    trx: DbTransaction,
  ): Promise<{ userId: string }>;
  createInvitedUser(
    input: { email: string; role: InvitedRole },
    trx: DbTransaction,
  ): Promise<{ userId: string }>;
  /** Batched (G20). Unknown ids are left out. */
  getUsersByIds(ids: readonly string[]): Promise<UserSummary[]>;
  /** Suspending revokes every session. USER_NOT_FOUND, USER_INVALID_STATUS_TRANSITION. */
  setUserStatus(
    userId: string,
    status: typeof UserStatus.ACTIVE | typeof UserStatus.SUSPENDED,
    actorUserId: string,
    trx: DbTransaction,
  ): Promise<void>;
}

@injectable()
export class AccountService implements IAccountService {
  constructor(
    @inject(TOKENS.UserRepository) private readonly users: UserRepository,
    @inject(TOKENS.VerificationCodeService) private readonly codes: VerificationCodeService,
    @inject(TOKENS.IdentityEmailNotifier) private readonly notifier: IdentityEmailNotifier,
    @inject(TOKENS.PasswordHasher) private readonly hasher: IPasswordHasher,
    @inject(TOKENS.InvitationService) private readonly invitations: InvitationService,
    @inject(TOKENS.UserAdminService) private readonly userAdmin: UserAdminService,
  ) {}

  async hashPassword(password: string): Promise<PasswordHash> {
    return (await this.hasher.hash(password)) as PasswordHash;
  }

  /** `email` must already be normalised (the callers' DTOs trim and lower-case it). */
  async createPendingUser(
    input: { email: string; passwordHash: PasswordHash; role: SelfRegisteredRole },
    trx: DbTransaction,
  ): Promise<{ userId: string }> {
    // Guards against a cast at the call site: other roles never self-register.
    if (!SELF_REGISTERED_ROLES.has(input.role)) throw new Error(`Role ${input.role} cannot self-register`);
    const user = await this.users.insert(
      {
        email: input.email,
        passwordHash: input.passwordHash,
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
    const user = await this.invitations.invite(input.email, input.role, trx);
    return { userId: user.id };
  }

  async getUsersByIds(ids: readonly string[]): Promise<UserSummary[]> {
    const users = await this.users.findByIds(ids);
    return users.map((user) => ({
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
    }));
  }

  async setUserStatus(
    userId: string,
    status: typeof UserStatus.ACTIVE | typeof UserStatus.SUSPENDED,
    actorUserId: string,
    trx: DbTransaction,
  ): Promise<void> {
    await this.userAdmin.changeStatus(userId, status, { actorUserId }, trx);
  }
}
