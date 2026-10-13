import { inject, injectable } from 'tsyringe';
import { UserRole } from '../../../lib/auth';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { UserStatus } from '../enums';
import { userNotFound, userNotInvited } from '../errors';
import { type User } from '../model/user.model';
import { type UserRepository } from '../repository/user.repository';
import { type IdentityEmailNotifier, recipientOf } from './identity-email.notifier';
import { type VerificationCodeService } from './verification-code.service';

/** Roles created by an admin invite (spec 03 UC-ID-7). */
export type InvitedRole = typeof UserRole.ADMIN | typeof UserRole.DELIVERY_AGENT;

const INVITED_ROLES: ReadonlySet<UserRole> = new Set([UserRole.ADMIN, UserRole.DELIVERY_AGENT]);

/**
 * Invited accounts (UC-ID-7, UC-ID-8). Needs no password hasher, so the seed-admin CLI can use it
 * without the api's bcrypt settings.
 */
@injectable()
export class InvitationService {
  constructor(
    @inject(TOKENS.UserRepository) private readonly users: UserRepository,
    @inject(TOKENS.VerificationCodeService) private readonly codes: VerificationCodeService,
    @inject(TOKENS.IdentityEmailNotifier) private readonly notifier: IdentityEmailNotifier,
  ) {}

  /** `email` must already be normalised. A duplicate fails on `uq_users_email` (EMAIL_ALREADY_REGISTERED). */
  async invite(email: string, role: InvitedRole, trx: DbTransaction): Promise<User> {
    // Guards against a cast at the call site: other roles register themselves.
    if (!INVITED_ROLES.has(role)) throw new Error(`Role ${role} cannot be invited`);
    const user = await this.users.insert(
      { email, passwordHash: null, role, status: UserStatus.INVITED },
      trx,
    );
    await this.sendInvite(user, trx);
    return user;
  }

  /** A new link invalidates the previous one. Only for users still `invited`. */
  async resendInvite(userId: string, trx: DbTransaction): Promise<void> {
    const user = await this.users.findById(userId, trx, { forUpdate: true });
    if (!user) throw userNotFound();
    if (!user.isInvited()) throw userNotInvited();
    await this.sendInvite(user, trx);
  }

  private async sendInvite(user: User, trx: DbTransaction): Promise<void> {
    const { token, expiresAt } = await this.codes.issueInvite(user.id, trx);
    await this.notifier.requestInviteEmail(trx, recipientOf(user), user.role, token, expiresAt);
  }
}
