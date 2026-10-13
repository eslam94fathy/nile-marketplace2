import { describe, expect, it } from 'vitest';
import { TOKENS } from '../../../lib/di';
import { randomToken, sha256Hex } from '../../../pkg/crypto';
import { UserStatus } from '../enums';
import { TokenService } from '../service/token.service';
import { createFakes, FAKE_TRX, makeRefreshToken, makeUser, NOW } from './fakes';

function setup() {
  const fakes = createFakes();
  fakes.container.register(TOKENS.Env, { useValue: { REFRESH_TOKEN_TTL_DAYS: 30 } });
  return { ...fakes, service: fakes.container.resolve(TokenService) };
}

const errorCode = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (e: { code?: string }) => e.code,
  );

describe('identity TokenService', () => {
  describe('startSession', () => {
    it('opens a new family and stores only the SHA-256 of the refresh token', async () => {
      const { service, refreshTokens, signer } = setup();
      const user = makeUser({ role: 'admin' });
      const tokens = await service.startSession(user, 'Pixel 9', FAKE_TRX);

      expect(tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(tokens.refreshTokenExpiresAt).toEqual(new Date(NOW.getTime() + 30 * 86_400_000));
      expect(tokens.accessToken).toBe('signed.access.token');
      expect(signer.signAccessToken).toHaveBeenCalledWith({ userId: user.id, role: 'admin' });
      const stored = refreshTokens.insert.mock.calls[0]?.[0];
      expect(stored).toMatchObject({
        userId: user.id,
        tokenHash: sha256Hex(tokens.refreshToken),
        userAgent: 'Pixel 9',
      });
      expect(JSON.stringify(stored)).not.toContain(tokens.refreshToken);
    });

    it('each login is a separate family', async () => {
      const { service, refreshTokens } = setup();
      await service.startSession(makeUser(), null, FAKE_TRX);
      await service.startSession(makeUser(), null, FAKE_TRX);
      const families = refreshTokens.insert.mock.calls.map((call) => call[0].familyId);
      expect(new Set(families).size).toBe(2);
    });
  });

  describe('rotate (UC-ID-4)', () => {
    it('rejects a malformed token without touching the database', async () => {
      const { service, refreshTokens } = setup();
      expect(await errorCode(service.rotate('short'))).toBe('INVALID_REFRESH_TOKEN');
      expect(refreshTokens.findByHash).not.toHaveBeenCalled();
    });

    it('rejects unknown and expired tokens', async () => {
      const { service, refreshTokens } = setup();
      expect(await errorCode(service.rotate(randomToken()))).toBe('INVALID_REFRESH_TOKEN');
      refreshTokens.findByHash.mockResolvedValue(makeRefreshToken({ expiresAt: NOW }));
      expect(await errorCode(service.rotate(randomToken()))).toBe('INVALID_REFRESH_TOKEN');
      expect(refreshTokens.revokeFamily).not.toHaveBeenCalled();
    });

    it('rotates: revokes the old token, issues a new one in the SAME family, links them', async () => {
      const { service, refreshTokens, users } = setup();
      const user = makeUser();
      const current = makeRefreshToken({ userId: user.id });
      refreshTokens.findByHash.mockResolvedValue(current);
      users.findById.mockResolvedValue(user);

      const presented = randomToken();
      const result = await service.rotate(presented);

      expect(refreshTokens.findByHash).toHaveBeenCalledWith(sha256Hex(presented), FAKE_TRX, {
        forUpdate: true,
      });
      expect(refreshTokens.revokeIfActive).toHaveBeenCalledWith(current.id, NOW, FAKE_TRX);
      expect(refreshTokens.insert.mock.calls[0]?.[0]).toMatchObject({
        familyId: current.familyId,
        userAgent: 'iPhone',
      });
      expect(refreshTokens.setReplacedBy).toHaveBeenCalledWith(current.id, expect.any(String), FAKE_TRX);
      expect(result.user).toBe(user);
      expect(result.tokens.refreshToken).not.toBe(presented);
    });

    it('reuse of a revoked token revokes the whole family and logs REFRESH_TOKEN_REUSE', async () => {
      const { service, refreshTokens, logger } = setup();
      const reused = makeRefreshToken({ revokedAt: new Date(NOW.getTime() - 1000) });
      refreshTokens.findByHash.mockResolvedValue(reused);

      expect(await errorCode(service.rotate(randomToken()))).toBe('INVALID_REFRESH_TOKEN');
      expect(refreshTokens.revokeFamily).toHaveBeenCalledWith(reused.familyId, NOW, FAKE_TRX);
      expect(refreshTokens.insert).not.toHaveBeenCalled();
      expect(logger.entries).toEqual([
        expect.objectContaining({
          level: 'warn',
          fields: { event: 'REFRESH_TOKEN_REUSE', userId: reused.userId, familyId: reused.familyId },
        }),
      ]);
    });

    it('losing the conditional revoke (concurrent use) is treated as reuse', async () => {
      const { service, refreshTokens, users } = setup();
      const user = makeUser();
      refreshTokens.findByHash.mockResolvedValue(makeRefreshToken({ userId: user.id }));
      users.findById.mockResolvedValue(user);
      refreshTokens.revokeIfActive.mockResolvedValue(false);

      expect(await errorCode(service.rotate(randomToken()))).toBe('INVALID_REFRESH_TOKEN');
      expect(refreshTokens.revokeFamily).toHaveBeenCalled();
      expect(refreshTokens.insert).not.toHaveBeenCalled();
    });

    it.each([UserStatus.SUSPENDED, UserStatus.PENDING_EMAIL_VERIFICATION])(
      'a %s user cannot refresh, and the family is revoked',
      async (status) => {
        const { service, refreshTokens, users } = setup();
        const user = makeUser({ status });
        refreshTokens.findByHash.mockResolvedValue(makeRefreshToken({ userId: user.id }));
        users.findById.mockResolvedValue(user);

        expect(await errorCode(service.rotate(randomToken()))).toBe('INVALID_REFRESH_TOKEN');
        expect(refreshTokens.revokeFamily).toHaveBeenCalled();
      },
    );
  });

  describe('endSession / activeFamilyOf / revokeAllSessions', () => {
    it('logout revokes the family of a known token and is silent for unknown ones', async () => {
      const { service, refreshTokens } = setup();
      await expect(service.endSession(randomToken())).resolves.toBeUndefined();
      expect(refreshTokens.revokeFamily).not.toHaveBeenCalled();

      const known = makeRefreshToken();
      refreshTokens.findByHash.mockResolvedValue(known);
      await service.endSession(randomToken());
      expect(refreshTokens.revokeFamily).toHaveBeenCalledWith(known.familyId, NOW);
    });

    it('activeFamilyOf only returns a live family that belongs to the user', async () => {
      const { service, refreshTokens } = setup();
      const token = makeRefreshToken();
      refreshTokens.findByHash.mockResolvedValue(token);
      expect(await service.activeFamilyOf(randomToken(), token.userId, FAKE_TRX)).toBe(token.familyId);
      expect(await service.activeFamilyOf(randomToken(), 'someone-else', FAKE_TRX)).toBeUndefined();
      refreshTokens.findByHash.mockResolvedValue(makeRefreshToken({ userId: token.userId, revokedAt: NOW }));
      expect(await service.activeFamilyOf(randomToken(), token.userId, FAKE_TRX)).toBeUndefined();
    });

    it('revokeAllSessions passes the exception through', async () => {
      const { service, refreshTokens } = setup();
      await service.revokeAllSessions('user-1', FAKE_TRX, { exceptFamilyId: 'fam-1' });
      expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('user-1', NOW, FAKE_TRX, {
        exceptFamilyId: 'fam-1',
      });
    });
  });
});
