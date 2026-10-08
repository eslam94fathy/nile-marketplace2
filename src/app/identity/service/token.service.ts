import { randomUUID } from 'node:crypto';
import { inject, injectable } from 'tsyringe';
import { type JwtSigner } from '../../../lib/auth';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { randomToken, sha256Hex } from '../../../pkg/crypto';
import { addDuration, TimeUnit } from '../../../pkg/time';
import { MAX_DEVICE_NAME_LENGTH, OPAQUE_TOKEN_BYTES, OPAQUE_TOKEN_LENGTH } from '../constants';
import { invalidRefreshToken } from '../errors';
import { type RefreshToken } from '../model/refresh-token.model';
import { type User } from '../model/user.model';
import { type RefreshTokenRepository } from '../repository/refresh-token.repository';
import { type UserRepository } from '../repository/user.repository';

export interface SessionTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

type RotateOutcome =
  | { kind: 'rotated'; user: User; tokens: SessionTokens }
  | { kind: 'invalid' }
  | { kind: 'reused'; userId: string; familyId: string };

const OPAQUE_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${OPAQUE_TOKEN_LENGTH}}$`);

/**
 * Sessions = refresh-token families (architecture §10, spec 03 UC-ID-4/5):
 * opaque 256-bit tokens stored as SHA-256, rotated on every use, reuse revokes the whole family.
 */
@injectable()
export class TokenService {
  constructor(
    @inject(TOKENS.RefreshTokenRepository) private readonly refreshTokens: RefreshTokenRepository,
    @inject(TOKENS.UserRepository) private readonly users: UserRepository,
    @inject(TOKENS.JwtSigner) private readonly signer: JwtSigner,
    @inject(TOKENS.TransactionRunner) private readonly transactions: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'REFRESH_TOKEN_TTL_DAYS'>,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  /** A new login: a new token family. */
  async startSession(user: User, deviceName: string | null, trx: DbTransaction): Promise<SessionTokens> {
    const { tokens } = await this.issue(user, randomUUID(), deviceName, trx);
    return tokens;
  }

  /**
   * UC-ID-4. Decides inside the transaction and throws only after it commits, so a detected
   * reuse really revokes the family (throwing inside would roll the revocation back).
   */
  async rotate(presentedToken: string): Promise<{ user: User; tokens: SessionTokens }> {
    if (!OPAQUE_TOKEN_PATTERN.test(presentedToken)) throw invalidRefreshToken();
    const tokenHash = sha256Hex(presentedToken);

    const outcome = await this.transactions.run(async (trx): Promise<RotateOutcome> => {
      const now = this.clock.now();
      // FOR UPDATE: a concurrent refresh of the same token waits here, then sees it revoked.
      const current = await this.refreshTokens.findByHash(tokenHash, trx, { forUpdate: true });
      if (!current || current.isExpired(now)) return { kind: 'invalid' };

      if (current.isRevoked()) {
        await this.refreshTokens.revokeFamily(current.familyId, now, trx);
        return { kind: 'reused', userId: current.userId, familyId: current.familyId };
      }

      const user = await this.users.findById(current.userId, trx);
      if (!user?.isActive()) {
        await this.refreshTokens.revokeFamily(current.familyId, now, trx);
        return { kind: 'invalid' };
      }

      if (!(await this.refreshTokens.revokeIfActive(current.id, now, trx))) {
        await this.refreshTokens.revokeFamily(current.familyId, now, trx);
        return { kind: 'reused', userId: current.userId, familyId: current.familyId };
      }
      const { tokens, row } = await this.issue(user, current.familyId, current.userAgent, trx);
      await this.refreshTokens.setReplacedBy(current.id, row.id, trx);
      return { kind: 'rotated', user, tokens };
    });

    if (outcome.kind === 'rotated') return { user: outcome.user, tokens: outcome.tokens };
    if (outcome.kind === 'reused') {
      this.logger.warn('refresh token reuse detected, session family revoked', {
        event: 'REFRESH_TOKEN_REUSE',
        userId: outcome.userId,
        familyId: outcome.familyId,
      });
    }
    throw invalidRefreshToken();
  }

  /** UC-ID-5 logout: revokes the presented token's family. Silent for unknown tokens. */
  async endSession(presentedToken: string): Promise<void> {
    if (!OPAQUE_TOKEN_PATTERN.test(presentedToken)) return;
    const current = await this.refreshTokens.findByHash(sha256Hex(presentedToken));
    if (current) await this.refreshTokens.revokeFamily(current.familyId, this.clock.now());
  }

  /** The live family of `presentedToken` if it belongs to `userId` (password change keeps it). */
  async activeFamilyOf(
    presentedToken: string,
    userId: string,
    trx: DbTransaction,
  ): Promise<string | undefined> {
    if (!OPAQUE_TOKEN_PATTERN.test(presentedToken)) return undefined;
    const current = await this.refreshTokens.findByHash(sha256Hex(presentedToken), trx);
    const usable =
      current && current.userId === userId && !current.isRevoked() && !current.isExpired(this.clock.now());
    return usable ? current.familyId : undefined;
  }

  /** Suspend, password reset (all sessions) and password change (all but the caller's). */
  revokeAllSessions(
    userId: string,
    trx: DbTransaction,
    options: { exceptFamilyId?: string } = {},
  ): Promise<number> {
    return this.refreshTokens.revokeAllForUser(userId, this.clock.now(), trx, options);
  }

  private async issue(
    user: User,
    familyId: string,
    deviceName: string | null,
    trx: DbTransaction,
  ): Promise<{ tokens: SessionTokens; row: RefreshToken }> {
    const now = this.clock.now();
    const refreshToken = randomToken(OPAQUE_TOKEN_BYTES);
    const refreshTokenExpiresAt = addDuration(now, this.env.REFRESH_TOKEN_TTL_DAYS, TimeUnit.DAY);
    const row = await this.refreshTokens.insert(
      {
        userId: user.id,
        familyId,
        tokenHash: sha256Hex(refreshToken),
        expiresAt: refreshTokenExpiresAt,
        userAgent: deviceName?.slice(0, MAX_DEVICE_NAME_LENGTH) ?? null,
        createdAt: now,
      },
      trx,
    );
    const access = await this.signer.signAccessToken({ userId: user.id, role: user.role });
    return {
      tokens: {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken,
        refreshTokenExpiresAt,
      },
      row,
    };
  }
}
