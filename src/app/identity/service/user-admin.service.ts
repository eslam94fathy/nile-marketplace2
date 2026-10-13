import { inject, injectable } from 'tsyringe';
import { type ISuspendedUsers, UserRole } from '../../../lib/auth';
import { afterCommit, type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ILogger } from '../../../lib/logger';
import { UserStatus } from '../enums';
import { cannotSuspendSelf, userInvalidStatusTransition, userNotFound } from '../errors';
import { type User } from '../model/user.model';
import { type UserRepository } from '../repository/user.repository';
import { type InvitationService } from './invitation.service';
import { type TokenService } from './token.service';

type TargetStatus = typeof UserStatus.ACTIVE | typeof UserStatus.SUSPENDED;

/** Only `active ⇄ suspended`: invited/pending accounts have no verified login to suspend or restore. */
const TRANSITION_FROM: Readonly<Record<TargetStatus, readonly UserStatus[]>> = {
  [UserStatus.SUSPENDED]: [UserStatus.ACTIVE],
  [UserStatus.ACTIVE]: [UserStatus.SUSPENDED],
};

/**
 * S-2: the admin endpoints suspend customers and admins only. Agents are suspended through
 * deactivation (S-10, via `setUserStatus`), sellers through seller suspension (spec 05).
 */
export const ADMIN_SUSPENDABLE_ROLES: readonly UserRole[] = [UserRole.CUSTOMER, UserRole.ADMIN];

export interface StatusChange {
  actorUserId: string;
  reason?: string;
  /** Restricts which roles may change (the admin endpoints); omitted = any role. */
  allowedRoles?: readonly UserRole[];
}

/** Admin use cases of spec 03 §4.10–§4.13 and `setUserStatus` of the public API. */
@injectable()
export class UserAdminService {
  constructor(
    @inject(TOKENS.UserRepository) private readonly users: UserRepository,
    @inject(TOKENS.InvitationService) private readonly invitations: InvitationService,
    @inject(TOKENS.TokenService) private readonly tokens: TokenService,
    @inject(TOKENS.TransactionRunner) private readonly transactions: ITransactionRunner,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.SuspendedUsers) private readonly suspendedUsers: ISuspendedUsers,
  ) {}

  /** §4.10. EMAIL_ALREADY_REGISTERED comes from the `uq_users_email` mapping. */
  async inviteAdmin(email: string, actorUserId: string): Promise<User> {
    const user = await this.transactions.run((trx) => this.invitations.invite(email, UserRole.ADMIN, trx));
    this.logger.info('admin invited', { event: 'ADMIN_INVITED', userId: user.id, actorUserId });
    return user;
  }

  /** §4.11. */
  async listAdmins(query: ParsedListQuery): Promise<{ items: User[]; meta: PageMeta }> {
    const rows = await this.users.listByRole(UserRole.ADMIN, query);
    return toPage(rows, query, (user) => user.createdAt);
  }

  /** §4.12. */
  resendInvite(userId: string): Promise<void> {
    return this.transactions.run((trx) => this.invitations.resendInvite(userId, trx));
  }

  /** §4.13 (admin endpoints): in its own transaction; the deny entry is in place before it answers. */
  async setStatus(userId: string, to: TargetStatus, change: StatusChange): Promise<User> {
    const user = await this.transactions.run((trx) => this.changeStatus(userId, to, change, trx));
    await this.syncDenyEntry(user.id, to);
    return user;
  }

  /** For a change made in the caller's transaction (`setUserStatus`): the deny entry follows its commit. */
  syncDenyEntryAfterCommit(trx: DbTransaction, userId: string, to: TargetStatus): void {
    afterCommit(trx, () => this.syncDenyEntry(userId, to));
  }

  /**
   * Spec 03 I-11: a suspension blocks the access tokens already issued; reactivation lifts it. If Redis
   * fails the change still stands and the tokens expire within their TTL.
   */
  private async syncDenyEntry(userId: string, to: TargetStatus): Promise<void> {
    try {
      if (to === UserStatus.SUSPENDED) await this.suspendedUsers.block(userId);
      else await this.suspendedUsers.unblock(userId);
    } catch (error) {
      this.logger.warn('suspended-user deny entry not updated', {
        event: 'SUSPENSION_DENY_ENTRY_FAILED',
        userId,
        status: to,
        error,
      });
    }
  }

  /** Suspending revokes every session (spec 03 §2). Conditional update: no read-then-write race. */
  async changeStatus(
    userId: string,
    to: TargetStatus,
    change: StatusChange,
    trx: DbTransaction,
  ): Promise<User> {
    const user = await this.users.findById(userId, trx, { forUpdate: true });
    if (!user) throw userNotFound();
    if (change.allowedRoles && !change.allowedRoles.includes(user.role)) throw userInvalidStatusTransition();
    if (to === UserStatus.SUSPENDED && user.id === change.actorUserId) throw cannotSuspendSelf();

    const updated = await this.users.transitionStatus(user.id, TRANSITION_FROM[to], to, trx);
    if (!updated) throw userInvalidStatusTransition();
    if (to === UserStatus.SUSPENDED) await this.tokens.revokeAllSessions(user.id, trx);

    this.logger.info(to === UserStatus.SUSPENDED ? 'user suspended' : 'user reactivated', {
      event: to === UserStatus.SUSPENDED ? 'USER_SUSPENDED' : 'USER_REACTIVATED',
      userId: user.id,
      actorUserId: change.actorUserId,
      reason: change.reason,
    });
    return updated;
  }
}
