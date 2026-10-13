import { describe, expect, it } from 'vitest';
import { TOKENS } from '../../../lib/di';
import { randomToken, sha256Hex } from '../../../pkg/crypto';
import { VerificationCodeService } from '../service/verification-code.service';
import { createFakes, FAKE_TRX, makeCode, NOW } from './fakes';

function setup() {
  const fakes = createFakes();
  fakes.container.register(TOKENS.Env, {
    useValue: {
      OTP_TTL_MINUTES: 10,
      OTP_MAX_ATTEMPTS: 5,
      OTP_RESEND_COOLDOWN_SECONDS: 60,
      INVITE_TTL_HOURS: 72,
    },
  });
  return { ...fakes, service: fakes.container.resolve(VerificationCodeService) };
}

describe('identity VerificationCodeService', () => {
  describe('OTPs', () => {
    it('issues a 6-digit OTP, stores only its hash, expires after OTP_TTL_MINUTES', async () => {
      const { service, codes } = setup();
      const { otp, expiresAt } = await service.issueOtp('user-1', 'email_verification', FAKE_TRX);
      expect(otp).toMatch(/^\d{6}$/);
      expect(expiresAt).toEqual(new Date(NOW.getTime() + 10 * 60_000));
      expect(codes.insert).toHaveBeenCalledWith(
        {
          userId: 'user-1',
          purpose: 'email_verification',
          codeHash: sha256Hex(otp),
          expiresAt,
          createdAt: NOW,
        },
        FAKE_TRX,
      );
    });

    it('accepts the right code of the latest open code (locked FOR UPDATE)', async () => {
      const { service, codes } = setup();
      const code = makeCode({ codeHash: sha256Hex('123456') });
      codes.findLatestActive.mockResolvedValue(code);
      expect(await service.checkOtp('user-1', 'email_verification', '123456', FAKE_TRX)).toEqual({
        ok: true,
        codeId: code.id,
      });
      expect(codes.findLatestActive).toHaveBeenCalledWith('user-1', 'email_verification', FAKE_TRX, {
        forUpdate: true,
      });
      expect(codes.incrementAttempts).not.toHaveBeenCalled();
    });

    it('a wrong code counts an attempt', async () => {
      const { service, codes } = setup();
      const code = makeCode({ codeHash: sha256Hex('123456') });
      codes.findLatestActive.mockResolvedValue(code);
      expect(await service.checkOtp('user-1', 'email_verification', '654321', FAKE_TRX)).toEqual({
        ok: false,
      });
      expect(codes.incrementAttempts).toHaveBeenCalledWith(code.id, FAKE_TRX);
    });

    it.each([
      ['no open code', undefined],
      ['expired', makeCode({ codeHash: sha256Hex('123456'), expiresAt: NOW })],
      [
        'attempts exhausted (even with the right code)',
        makeCode({ codeHash: sha256Hex('123456'), attempts: 5 }),
      ],
    ])('%s → not ok, no attempt counted', async (_case, code) => {
      const { service, codes } = setup();
      codes.findLatestActive.mockResolvedValue(code);
      expect(await service.checkOtp('user-1', 'email_verification', '123456', FAKE_TRX)).toEqual({
        ok: false,
      });
      expect(codes.incrementAttempts).not.toHaveBeenCalled();
    });

    it('cooldown: blocks a new code while the latest one is younger than OTP_RESEND_COOLDOWN_SECONDS', async () => {
      const { service, codes } = setup();
      expect(await service.isOutsideCooldown('user-1', 'password_reset')).toBe(true);
      codes.findLatestActive.mockResolvedValue(makeCode({ createdAt: new Date(NOW.getTime() - 59_000) }));
      expect(await service.isOutsideCooldown('user-1', 'password_reset')).toBe(false);
      codes.findLatestActive.mockResolvedValue(makeCode({ createdAt: new Date(NOW.getTime() - 60_000) }));
      expect(await service.isOutsideCooldown('user-1', 'password_reset')).toBe(true);
    });
  });

  describe('invites', () => {
    it('a new invite invalidates the previous one, stores only the hash, expires after INVITE_TTL_HOURS', async () => {
      const { service, codes } = setup();
      const { token, expiresAt } = await service.issueInvite('user-1', FAKE_TRX);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(expiresAt).toEqual(new Date(NOW.getTime() + 72 * 3_600_000));
      expect(codes.consumeAllActive).toHaveBeenCalledWith('user-1', 'account_invite', NOW, FAKE_TRX);
      expect(codes.consumeAllActive.mock.invocationCallOrder[0]).toBeLessThan(
        codes.insert.mock.invocationCallOrder[0] ?? 0,
      );
      expect(codes.insert.mock.calls[0]?.[0]).toMatchObject({
        purpose: 'account_invite',
        codeHash: sha256Hex(token),
      });
    });

    it('findUsableInvite: malformed or expired tokens are not usable', async () => {
      const { service, codes } = setup();
      expect(await service.findUsableInvite('nope', FAKE_TRX)).toBeUndefined();
      expect(codes.findUnconsumedInviteByHash).not.toHaveBeenCalled();

      const token = randomToken();
      codes.findUnconsumedInviteByHash.mockResolvedValue(
        makeCode({ purpose: 'account_invite', expiresAt: NOW }),
      );
      expect(await service.findUsableInvite(token, FAKE_TRX)).toBeUndefined();

      const open = makeCode({ purpose: 'account_invite', attempts: 99 });
      codes.findUnconsumedInviteByHash.mockResolvedValue(open);
      expect(await service.findUsableInvite(token, FAKE_TRX)).toBe(open);
      expect(codes.findUnconsumedInviteByHash).toHaveBeenLastCalledWith(sha256Hex(token), FAKE_TRX, {
        forUpdate: true,
      });
    });
  });
});
