import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { addDuration, TimeUnit } from '../../../pkg/time';
import { type RefreshTokenRepository } from '../repository/refresh-token.repository';
import { type VerificationCodeRepository } from '../repository/verification-code.repository';

/** Rows per DELETE, so one run never holds a long lock or a huge transaction. */
const DELETE_BATCH_SIZE = 5_000;

/**
 * `expired-codes-cleanup` (architecture §6): OTPs, invites and refresh tokens whose expiry is older
 * than CODES_RETENTION_DAYS. Consumed codes and revoked tokens expire too, so they go the same way.
 */
@injectable()
export class IdentityCleanupService {
  constructor(
    @inject(TOKENS.RefreshTokenRepository) private readonly refreshTokens: RefreshTokenRepository,
    @inject(TOKENS.VerificationCodeRepository) private readonly codes: VerificationCodeRepository,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'CODES_RETENTION_DAYS'>,
  ) {}

  /** Returns the number of rows deleted. */
  async run(): Promise<number> {
    const cutoff = addDuration(this.clock.now(), -this.env.CODES_RETENTION_DAYS, TimeUnit.DAY);
    const codes = await this.inBatches((limit) => this.codes.deleteExpiredBefore(cutoff, limit));
    const tokens = await this.inBatches((limit) => this.refreshTokens.deleteExpiredBefore(cutoff, limit));
    return codes + tokens;
  }

  private async inBatches(deleteBatch: (limit: number) => Promise<number>): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await deleteBatch(DELETE_BATCH_SIZE);
      total += deleted;
      if (deleted < DELETE_BATCH_SIZE) return total;
    }
  }
}
