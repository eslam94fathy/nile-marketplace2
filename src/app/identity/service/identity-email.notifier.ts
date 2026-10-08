import { inject, injectable } from 'tsyringe';
import { type UserRole } from '../../../lib/auth';
import { type Env } from '../../../lib/config';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type EmailTemplate, type IOutbox, NotificationEmailRequested } from '../../../lib/events';
import { type ISecretBox } from '../../../pkg/crypto';
import { INVITE_TOKEN_QUERY_PARAM } from '../constants';
import { type OtpPurpose } from '../enums';

type NotifierEnv = Pick<Env, 'OTP_TTL_MINUTES' | 'INVITE_URL_BASE'>;

/**
 * Queues transactional emails as `notification.email_requested` in the caller's transaction.
 * Secrets (OTP, invite link) are sealed with AES-256-GCM, AAD = `${userId}:${template}`,
 * so they never sit in plain text in the outbox or the broker (S-1, docs/spec/02-events.md §3.1).
 */
@injectable()
export class IdentityEmailNotifier {
  constructor(
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.SecretBox) private readonly secretBox: ISecretBox,
    @inject(TOKENS.Env) private readonly env: NotifierEnv,
  ) {}

  /** `purpose` doubles as the template name (email_verification / password_reset). */
  requestOtpEmail(
    trx: DbTransaction,
    to: { userId: string; email: string },
    purpose: OtpPurpose,
    otp: string,
  ): Promise<void> {
    return this.request(trx, to, purpose, { expiresInMinutes: this.env.OTP_TTL_MINUTES }, { otp });
  }

  requestInviteEmail(
    trx: DbTransaction,
    to: { userId: string; email: string },
    role: UserRole,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    const inviteUrl = new URL(this.env.INVITE_URL_BASE);
    inviteUrl.searchParams.set(INVITE_TOKEN_QUERY_PARAM, token);
    return this.request(
      trx,
      to,
      'account_invite',
      { role, expiresAt: expiresAt.toISOString() },
      { inviteUrl: inviteUrl.toString() },
    );
  }

  private request(
    trx: DbTransaction,
    to: { userId: string; email: string },
    template: EmailTemplate,
    variables: { expiresInMinutes: number } | { role: UserRole; expiresAt: string },
    secrets: { otp: string } | { inviteUrl: string },
  ): Promise<void> {
    return this.outbox.add(trx, {
      contract: NotificationEmailRequested,
      aggregateId: to.userId,
      payload: {
        template,
        userId: to.userId,
        toEmail: to.email,
        variables,
        encryptedSecrets: this.secretBox.seal(JSON.stringify(secrets), `${to.userId}:${template}`),
      },
    });
  }
}
