import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserStatus } from '../../src/app/identity';
import { type User } from '../../src/app/identity/model/user.model';
import { type UserRepository } from '../../src/app/identity/repository/user.repository';
import { type VerificationCodeRepository } from '../../src/app/identity/repository/verification-code.repository';
import { type TokenService } from '../../src/app/identity/service/token.service';
import { type VerificationCodeService } from '../../src/app/identity/service/verification-code.service';
import { TOKENS } from '../../src/lib/di';
import { startTestApp, type TestApp } from '../helpers/test-app';

/*
 * Real-Postgres behaviour of the identity services that fakes can't show: row locks,
 * conditional updates and "decide in the transaction, throw after the commit".
 * (Test files may reach module internals; production code goes through index.ts only.)
 */
describe('identity sessions and codes on a real database', () => {
  let t: TestApp;
  let tokens: TokenService;
  let codes: VerificationCodeService;
  let users: UserRepository;
  let codeRepository: VerificationCodeRepository;

  const createUser = (
    status: (typeof UserStatus)[keyof typeof UserStatus] = UserStatus.ACTIVE,
  ): Promise<User> =>
    t.infra.db.run((trx) =>
      users.insert(
        {
          email: `${randomUUID()}@example.com`,
          passwordHash:
            status === UserStatus.INVITED
              ? null
              : '$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234',
          role: 'customer',
          status,
        },
        trx,
      ),
    );
  const login = (user: User) => t.infra.db.run((trx) => tokens.startSession(user, 'test-device', trx));
  const codeOf = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (e: { code?: string }) => e.code,
    );

  beforeAll(async () => {
    t = await startTestApp();
    tokens = t.container.resolve<TokenService>(TOKENS.TokenService);
    codes = t.container.resolve<VerificationCodeService>(TOKENS.VerificationCodeService);
    users = t.container.resolve<UserRepository>(TOKENS.UserRepository);
    codeRepository = t.container.resolve<VerificationCodeRepository>(TOKENS.VerificationCodeRepository);
  });
  afterAll(async () => {
    await t.close();
  });

  describe('refresh rotation', () => {
    it('rotates; replaying the old token revokes the whole family (including the new token)', async () => {
      const session = await login(await createUser());
      const rotated = await tokens.rotate(session.refreshToken);

      expect(await codeOf(tokens.rotate(session.refreshToken))).toBe('INVALID_REFRESH_TOKEN');
      // The revocation was committed even though rotate() threw.
      expect(await codeOf(tokens.rotate(rotated.tokens.refreshToken))).toBe('INVALID_REFRESH_TOKEN');
    });

    it('two concurrent refreshes of the same token: exactly one succeeds', async () => {
      const session = await login(await createUser());
      const results = await Promise.allSettled([
        tokens.rotate(session.refreshToken),
        tokens.rotate(session.refreshToken),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('logout revokes the session; a suspended user cannot refresh', async () => {
      const user = await createUser();
      const session = await login(user);
      await tokens.endSession(session.refreshToken);
      expect(await codeOf(tokens.rotate(session.refreshToken))).toBe('INVALID_REFRESH_TOKEN');

      const other = await login(user);
      await t.infra.db.run((trx) =>
        users.transitionStatus(user.id, [UserStatus.ACTIVE], UserStatus.SUSPENDED, trx),
      );
      expect(await codeOf(tokens.rotate(other.refreshToken))).toBe('INVALID_REFRESH_TOKEN');
    });

    it('revokeAllSessions can keep the caller session (password change)', async () => {
      const user = await createUser();
      const keep = await login(user);
      const drop = await login(user);
      await t.infra.db.run(async (trx) => {
        const family = await tokens.activeFamilyOf(keep.refreshToken, user.id, trx);
        expect(family).toBeDefined();
        expect(await tokens.revokeAllSessions(user.id, trx, { exceptFamilyId: family })).toBe(1);
      });
      expect(await codeOf(tokens.rotate(keep.refreshToken))).toBe('ok');
      expect(await codeOf(tokens.rotate(drop.refreshToken))).toBe('INVALID_REFRESH_TOKEN');
    });
  });

  describe('OTPs', () => {
    /** The caller pattern: check in a transaction that COMMITS, then report. */
    const check = (userId: string, otp: string) =>
      t.infra.db.run((trx) => codes.checkOtp(userId, 'email_verification', otp, trx));

    it('wrong codes are counted (and committed); after OTP_MAX_ATTEMPTS even the right code fails', async () => {
      const user = await createUser(UserStatus.PENDING_EMAIL_VERIFICATION);
      const { otp } = await t.infra.db.run((trx) => codes.issueOtp(user.id, 'email_verification', trx));
      const wrong = otp === '000000' ? '111111' : '000000';

      for (let i = 1; i <= 5; i += 1) {
        expect(await check(user.id, wrong)).toEqual({ ok: false });
        const latest = await codeRepository.findLatestActive(user.id, 'email_verification');
        expect(latest?.attempts).toBe(i);
      }
      expect(await check(user.id, otp)).toEqual({ ok: false });
    });

    it('only the latest code is accepted, and a code is single-use', async () => {
      const user = await createUser(UserStatus.PENDING_EMAIL_VERIFICATION);
      const first = await t.infra.db.run((trx) => codes.issueOtp(user.id, 'email_verification', trx));
      const second = await t.infra.db.run((trx) => codes.issueOtp(user.id, 'email_verification', trx));
      if (first.otp !== second.otp) expect(await check(user.id, first.otp)).toEqual({ ok: false });

      const result = await check(user.id, second.otp);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(await t.infra.db.run((trx) => codes.consume(result.codeId, trx))).toBe(true);
      expect(await t.infra.db.run((trx) => codes.consume(result.codeId, trx))).toBe(false);
    });
  });

  describe('invites', () => {
    it('a re-sent invite invalidates the previous link', async () => {
      const user = await createUser(UserStatus.INVITED);
      const first = await t.infra.db.run((trx) => codes.issueInvite(user.id, trx));
      const second = await t.infra.db.run((trx) => codes.issueInvite(user.id, trx));
      expect(await t.infra.db.run((trx) => codes.findUsableInvite(first.token, trx))).toBeUndefined();
      expect((await t.infra.db.run((trx) => codes.findUsableInvite(second.token, trx)))?.userId).toBe(
        user.id,
      );
    });
  });

  describe('users', () => {
    it('status transitions are conditional on the current status', async () => {
      const user = await createUser(UserStatus.INVITED);
      const activated = await t.infra.db.run((trx) =>
        users.transitionStatus(user.id, [UserStatus.INVITED], UserStatus.ACTIVE, trx, {
          passwordHash: '$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234',
          emailVerifiedAt: new Date(),
        }),
      );
      expect(activated?.status).toBe(UserStatus.ACTIVE);
      expect(activated?.emailVerifiedAt).toBeInstanceOf(Date);
      // Second attempt: no longer invited → no change.
      expect(
        await t.infra.db.run((trx) =>
          users.transitionStatus(user.id, [UserStatus.INVITED], UserStatus.ACTIVE, trx),
        ),
      ).toBeUndefined();
    });

    it('duplicate email maps to EMAIL_ALREADY_REGISTERED through the registered constraint', async () => {
      const user = await createUser();
      const error = await t.infra.db
        .run((trx) =>
          users.insert({ email: user.email, passwordHash: 'x', role: 'customer', status: 'active' }, trx),
        )
        .catch((caught: unknown) => caught);
      expect(t.infra.pgErrorMapper.map(error)?.code).toBe('EMAIL_ALREADY_REGISTERED');
    });
  });
});
