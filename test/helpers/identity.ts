import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { type IAccountService } from '../../src/app/identity';
import { type AuthTokensDto } from '../../src/app/identity/dto/auth-response.dto';
import { type UserRole } from '../../src/lib/auth';
import { TOKENS } from '../../src/lib/di';
import { successBody } from './http';
import { type TestApp } from './test-app';

export const API = '/api/v1';
export const PASSWORD = 'correct horse battery';
export const NEW_PASSWORD = 'another long passphrase';

export type EmailTemplate = 'email_verification' | 'password_reset' | 'account_invite';

export const newEmail = (): string => `user-${randomUUID()}@example.com`;

/** Identity fixtures over a test app: users are created through the module's public API. */
export function identityFixtures(t: TestApp) {
  const accounts = (): IAccountService => t.container.resolve<IAccountService>(TOKENS.AccountService);

  /** The decrypted secrets of the latest email of `template` queued for `userId`. */
  async function latestSecret(userId: string, template: EmailTemplate): Promise<Record<string, string>> {
    const row = await t.infra.db
      .knex('events_outbox')
      .select('payload')
      .where({ aggregate_id: userId, event_type: 'notification.email_requested' })
      .whereRaw("payload->>'template' = ?", [template])
      .orderBy('id', 'desc')
      .first<{ payload: { encryptedSecrets: string } } | undefined>();
    if (!row) throw new Error(`no ${template} email for ${userId}`);
    const plain = t.infra.secretBox.open(row.payload.encryptedSecrets, `${userId}:${template}`);
    return JSON.parse(plain) as Record<string, string>;
  }

  async function inviteToken(userId: string): Promise<string> {
    const { inviteUrl } = await latestSecret(userId, 'account_invite');
    const token = new URL(inviteUrl ?? '').searchParams.get('token');
    if (!token) throw new Error('missing invite token');
    return token;
  }

  async function createPending(
    email = newEmail(),
    role: 'customer' | 'seller' = 'customer',
  ): Promise<{ userId: string; email: string; otp: string }> {
    const { userId } = await t.infra.db.run((trx) =>
      accounts().createPendingUser({ email, password: PASSWORD, role }, trx),
    );
    const { otp } = await latestSecret(userId, 'email_verification');
    if (!otp) throw new Error('missing otp');
    return { userId, email, otp };
  }

  /** A verified, logged-in user (customer by default). */
  async function createActive(
    role: 'customer' | 'seller' = 'customer',
  ): Promise<{ userId: string; email: string; session: AuthTokensDto }> {
    const { userId, email, otp } = await createPending(newEmail(), role);
    const res = await request(t.app).post(`${API}/auth/email/verify`).send({ email, otp });
    if (res.status !== 200) throw new Error(`verify failed: ${res.status}`);
    return { userId, email, session: successBody<AuthTokensDto>(res).data };
  }

  async function createInvited(
    email = newEmail(),
    role: Extract<UserRole, 'admin' | 'delivery_agent'> = 'admin',
  ): Promise<{ userId: string; email: string; token: string }> {
    const { userId } = await t.infra.db.run((trx) => accounts().createInvitedUser({ email, role }, trx));
    return { userId, email, token: await inviteToken(userId) };
  }

  /** An admin who accepted the invite: a real account with a real session. */
  async function createActiveAdmin(): Promise<{ userId: string; email: string; session: AuthTokensDto }> {
    const { userId, email, token } = await createInvited();
    const res = await request(t.app).post(`${API}/auth/invite/accept`).send({ token, password: PASSWORD });
    if (res.status !== 200) throw new Error(`accept failed: ${res.status}`);
    return { userId, email, session: successBody<AuthTokensDto>(res).data };
  }

  return {
    accounts,
    latestSecret,
    inviteToken,
    createPending,
    createActive,
    createInvited,
    createActiveAdmin,
  };
}
