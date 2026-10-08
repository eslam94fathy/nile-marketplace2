import { describe, expect, it, vi } from 'vitest';
import { TOKENS } from '../../../lib/di';
import { UserStatus } from '../enums';
import { type OtpCheck } from '../service/verification-code.service';
import { AuthService } from '../service/auth.service';
import { createFakes, FAKE_TRX, makeCode, makeUser, NOW } from './fakes';

const SESSION = {
  accessToken: 'access',
  accessTokenExpiresAt: NOW,
  refreshToken: 'r'.repeat(43),
  refreshTokenExpiresAt: NOW,
};

function setup() {
  const fakes = createFakes();
  const tokens = {
    startSession: vi.fn(() => Promise.resolve(SESSION)),
    rotate: vi.fn(),
    endSession: vi.fn(() => Promise.resolve()),
    activeFamilyOf: vi.fn((): Promise<string | undefined> => Promise.resolve('family-1')),
    revokeAllSessions: vi.fn(() => Promise.resolve(1)),
  };
  const codes = {
    checkOtp: vi.fn((): Promise<OtpCheck> => Promise.resolve({ ok: true, codeId: 'code-1' })),
    consume: vi.fn(() => Promise.resolve(true)),
    isOutsideCooldown: vi.fn(() => Promise.resolve(true)),
    issueOtp: vi.fn(() => Promise.resolve({ otp: '123456', expiresAt: NOW })),
    findUsableInvite: vi.fn(() => Promise.resolve(makeCode({ purpose: 'account_invite' }))),
  };
  const notifier = { requestOtpEmail: vi.fn(() => Promise.resolve()) };
  fakes.container.register(TOKENS.TokenService, { useValue: tokens });
  fakes.container.register(TOKENS.VerificationCodeService, { useValue: codes });
  fakes.container.register(TOKENS.IdentityEmailNotifier, { useValue: notifier });
  return { ...fakes, tokens, codeService: codes, notifier, service: fakes.container.resolve(AuthService) };
}

const errorCode = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (e: { code?: string }) => e.code,
  );

describe('identity AuthService', () => {
  describe('login (UC-ID-3)', () => {
    it('runs bcrypt against a dummy hash for unknown and invited accounts', async () => {
      const { service, users, hasher } = setup();
      expect(await errorCode(service.login('nobody@x.io', 'pw', null))).toBe('INVALID_CREDENTIALS');
      users.findByEmail.mockResolvedValue(makeUser({ status: UserStatus.INVITED, passwordHash: null }));
      expect(await errorCode(service.login('invited@x.io', 'pw', null))).toBe('INVALID_CREDENTIALS');

      expect(hasher.verify).toHaveBeenCalledTimes(2);
      // One dummy hash, computed once and reused.
      expect(hasher.hash).toHaveBeenCalledTimes(1);
    });

    it('reports status errors only after a correct password', async () => {
      const { service, users } = setup();
      users.findByEmail.mockResolvedValue(
        makeUser({ status: UserStatus.SUSPENDED, passwordHash: 'hash:right' }),
      );
      expect(await errorCode(service.login('a@x.io', 'wrong', null))).toBe('INVALID_CREDENTIALS');
      expect(await errorCode(service.login('a@x.io', 'right', null))).toBe('ACCOUNT_SUSPENDED');

      users.findByEmail.mockResolvedValue(
        makeUser({ status: UserStatus.PENDING_EMAIL_VERIFICATION, passwordHash: 'hash:right' }),
      );
      expect(await errorCode(service.login('a@x.io', 'right', null))).toBe('EMAIL_NOT_VERIFIED');
    });

    it('opens a session and records the login time', async () => {
      const { service, users, tokens } = setup();
      const user = makeUser({ passwordHash: 'hash:right' });
      users.findByEmail.mockResolvedValue(user);
      const session = await service.login('a@x.io', 'right', 'Pixel');
      expect(session).toEqual({ user, tokens: SESSION });
      expect(users.touchLastLogin).toHaveBeenCalledWith(user.id, NOW, FAKE_TRX);
      expect(tokens.startSession).toHaveBeenCalledWith(user, 'Pixel', FAKE_TRX);
    });
  });

  describe('verifyEmail (UC-ID-1)', () => {
    it('INVALID_OTP when the account is not pending, without checking a code', async () => {
      const { service, users, codeService } = setup();
      users.findByEmail.mockResolvedValue(makeUser({ status: UserStatus.ACTIVE }));
      expect(await errorCode(service.verifyEmail('a@x.io', '123456'))).toBe('INVALID_OTP');
      expect(codeService.checkOtp).not.toHaveBeenCalled();
    });

    it('a wrong code: the transaction completes (attempt kept), then INVALID_OTP', async () => {
      const { service, users, codeService, tokens } = setup();
      users.findByEmail.mockResolvedValue(makeUser({ status: UserStatus.PENDING_EMAIL_VERIFICATION }));
      codeService.checkOtp.mockResolvedValue({ ok: false });
      expect(await errorCode(service.verifyEmail('a@x.io', '000000'))).toBe('INVALID_OTP');
      expect(codeService.consume).not.toHaveBeenCalled();
      expect(tokens.startSession).not.toHaveBeenCalled();
    });

    it('consumes the code, activates and logs in', async () => {
      const { service, users, codeService } = setup();
      const pending = makeUser({ status: UserStatus.PENDING_EMAIL_VERIFICATION });
      const active = makeUser({ id: pending.id, status: UserStatus.ACTIVE });
      users.findByEmail.mockResolvedValue(pending);
      users.transitionStatus.mockResolvedValue(active);

      expect(await service.verifyEmail('a@x.io', '123456')).toEqual({ user: active, tokens: SESSION });
      expect(codeService.consume).toHaveBeenCalledWith('code-1', FAKE_TRX);
      expect(users.transitionStatus).toHaveBeenCalledWith(
        pending.id,
        [UserStatus.PENDING_EMAIL_VERIFICATION],
        UserStatus.ACTIVE,
        FAKE_TRX,
        { emailVerifiedAt: NOW },
      );
    });
  });

  describe('resend / forgot', () => {
    it('sends only for the required status and outside the cooldown', async () => {
      const { service, users, codeService, notifier } = setup();
      await service.forgotPassword('nobody@x.io');
      users.findByEmail.mockResolvedValue(makeUser({ status: UserStatus.PENDING_EMAIL_VERIFICATION }));
      await service.forgotPassword('pending@x.io');
      users.findByEmail.mockResolvedValue(makeUser({ status: UserStatus.ACTIVE }));
      codeService.isOutsideCooldown.mockResolvedValueOnce(false);
      await service.forgotPassword('cooling@x.io');
      expect(notifier.requestOtpEmail).not.toHaveBeenCalled();

      await service.forgotPassword('active@x.io');
      expect(codeService.issueOtp).toHaveBeenCalledWith(expect.any(String), 'password_reset', FAKE_TRX);
      expect(notifier.requestOtpEmail).toHaveBeenCalledTimes(1);
    });

    it('locks the user row so concurrent requests see one cooldown', async () => {
      const { service, users } = setup();
      await service.resendVerificationOtp('a@x.io');
      expect(users.findByEmail).toHaveBeenCalledWith('a@x.io', FAKE_TRX, { forUpdate: true });
    });
  });

  describe('resetPassword (UC-ID-6)', () => {
    it('stores the new hash and revokes every session', async () => {
      const { service, users, tokens } = setup();
      const user = makeUser();
      users.findByEmail.mockResolvedValue(user);
      await service.resetPassword('a@x.io', '123456', 'new password');
      expect(users.updatePasswordHash).toHaveBeenCalledWith(user.id, 'hash:new password', FAKE_TRX);
      expect(tokens.revokeAllSessions).toHaveBeenCalledWith(user.id, FAKE_TRX);
    });

    it('INVALID_OTP for an inactive account or a consumed code', async () => {
      const { service, users, codeService } = setup();
      users.findByEmail.mockResolvedValue(makeUser({ status: UserStatus.SUSPENDED }));
      expect(await errorCode(service.resetPassword('a@x.io', '123456', 'new password'))).toBe('INVALID_OTP');
      users.findByEmail.mockResolvedValue(makeUser());
      codeService.consume.mockResolvedValue(false);
      expect(await errorCode(service.resetPassword('a@x.io', '123456', 'new password'))).toBe('INVALID_OTP');
      expect(users.updatePasswordHash).not.toHaveBeenCalled();
    });
  });

  describe('acceptInvite (UC-ID-7)', () => {
    it('activates with the new password and a verified email', async () => {
      const { service, users } = setup();
      const active = makeUser({ role: 'admin' });
      users.transitionStatus.mockResolvedValue(active);
      expect(await service.acceptInvite('t'.repeat(43), 'a password')).toEqual({
        user: active,
        tokens: SESSION,
      });
      expect(users.transitionStatus).toHaveBeenCalledWith(
        expect.any(String),
        [UserStatus.INVITED],
        UserStatus.ACTIVE,
        FAKE_TRX,
        { passwordHash: 'hash:a password', emailVerifiedAt: NOW },
      );
    });

    it('INVALID_INVITE_TOKEN when there is no usable invite or the user is no longer invited', async () => {
      const { service, users, codeService } = setup();
      expect(await errorCode(service.acceptInvite('t'.repeat(43), 'a password'))).toBe(
        'INVALID_INVITE_TOKEN',
      );
      users.transitionStatus.mockResolvedValue(makeUser());
      codeService.findUsableInvite.mockResolvedValue(undefined as never);
      expect(await errorCode(service.acceptInvite('t'.repeat(43), 'a password'))).toBe(
        'INVALID_INVITE_TOKEN',
      );
    });
  });

  describe('changePassword (spec 03 §4.9b)', () => {
    const input = {
      currentPassword: 'old password',
      newPassword: 'new password',
      refreshToken: 'r'.repeat(43),
    };

    it('replaces the verified hash and keeps only the caller session', async () => {
      const { service, users, tokens } = setup();
      const user = makeUser({ passwordHash: 'hash:old password' });
      users.findById.mockResolvedValue(user);
      await service.changePassword(user.id, input);
      expect(users.replacePasswordHash).toHaveBeenCalledWith(
        user.id,
        'hash:old password',
        'hash:new password',
        FAKE_TRX,
      );
      expect(tokens.revokeAllSessions).toHaveBeenCalledWith(user.id, FAKE_TRX, {
        exceptFamilyId: 'family-1',
      });
    });

    it('error order: current password, then unchanged, then the session', async () => {
      const { service, users, tokens } = setup();
      users.findById.mockResolvedValue(makeUser({ passwordHash: 'hash:old password' }));
      expect(await errorCode(service.changePassword('u', { ...input, currentPassword: 'x' }))).toBe(
        'INVALID_CURRENT_PASSWORD',
      );
      expect(
        await errorCode(service.changePassword('u', { ...input, newPassword: input.currentPassword })),
      ).toBe('PASSWORD_UNCHANGED');
      tokens.activeFamilyOf.mockResolvedValue(undefined);
      expect(await errorCode(service.changePassword('u', input))).toBe('INVALID_REFRESH_TOKEN');
      expect(users.replacePasswordHash).not.toHaveBeenCalled();
    });

    it('a concurrent change (hash moved on) fails with INVALID_CURRENT_PASSWORD', async () => {
      const { service, users, tokens } = setup();
      users.findById.mockResolvedValue(makeUser({ passwordHash: 'hash:old password' }));
      users.replacePasswordHash.mockResolvedValue(false);
      expect(await errorCode(service.changePassword('u', input))).toBe('INVALID_CURRENT_PASSWORD');
      expect(tokens.revokeAllSessions).not.toHaveBeenCalled();
    });
  });
});
