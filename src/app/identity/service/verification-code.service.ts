import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { constantTimeEqual, randomNumericCode, randomToken, sha256Hex } from '../../../pkg/crypto';
import { addDuration, TimeUnit, toMs } from '../../../pkg/time';
import { OPAQUE_TOKEN_BYTES, OPAQUE_TOKEN_LENGTH, OTP_DIGITS } from '../constants';
import { type OtpPurpose, VerificationPurpose } from '../enums';
import { type VerificationCode } from '../model/verification-code.model';
import { type VerificationCodeRepository } from '../repository/verification-code.repository';

type CodeEnv = Pick<
  Env,
  'OTP_TTL_MINUTES' | 'OTP_MAX_ATTEMPTS' | 'OTP_RESEND_COOLDOWN_SECONDS' | 'INVITE_TTL_HOURS'
>;

export type OtpCheck = { ok: true; codeId: string } | { ok: false };

const OPAQUE_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${OPAQUE_TOKEN_LENGTH}}$`);

/**
 * OTPs (6 digits) and invite tokens (256-bit), stored only as SHA-256 (architecture §10):
 * expiry and attempt limit from env, single use, and only the latest code is accepted.
 */
@injectable()
export class VerificationCodeService {
  constructor(
    @inject(TOKENS.VerificationCodeRepository) private readonly codes: VerificationCodeRepository,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Env) private readonly env: CodeEnv,
  ) {}

  async issueOtp(
    userId: string,
    purpose: OtpPurpose,
    trx: DbTransaction,
  ): Promise<{ otp: string; expiresAt: Date }> {
    const now = this.clock.now();
    const otp = randomNumericCode(OTP_DIGITS);
    const expiresAt = addDuration(now, this.env.OTP_TTL_MINUTES, TimeUnit.MINUTE);
    await this.codes.insert({ userId, purpose, codeHash: sha256Hex(otp), expiresAt, createdAt: now }, trx);
    return { otp, expiresAt };
  }

  /** Resend/forgot cooldown: false while the latest open code is younger than the cooldown. */
  async isOutsideCooldown(userId: string, purpose: OtpPurpose, trx?: DbTransaction): Promise<boolean> {
    const latest = await this.codes.findLatestActive(userId, purpose, trx);
    if (!latest) return true;
    const ageMs = this.clock.now().getTime() - latest.createdAt.getTime();
    return ageMs >= toMs(this.env.OTP_RESEND_COOLDOWN_SECONDS, TimeUnit.SECOND);
  }

  /**
   * Checks an OTP against the latest open code (locked FOR UPDATE). A wrong code counts an attempt.
   * The caller consumes the code on success, and must let the transaction COMMIT on failure too,
   * so the attempt is recorded (throw INVALID_OTP after the commit).
   */
  async checkOtp(userId: string, purpose: OtpPurpose, otp: string, trx: DbTransaction): Promise<OtpCheck> {
    const latest = await this.codes.findLatestActive(userId, purpose, trx, { forUpdate: true });
    if (!latest?.isUsable(this.clock.now(), this.env.OTP_MAX_ATTEMPTS)) return { ok: false };
    if (!constantTimeEqual(sha256Hex(otp), latest.codeHash)) {
      await this.codes.incrementAttempts(latest.id, trx);
      return { ok: false };
    }
    return { ok: true, codeId: latest.id };
  }

  /** Conditional: false if another request consumed it first. */
  consume(codeId: string, trx: DbTransaction): Promise<boolean> {
    return this.codes.consume(codeId, this.clock.now(), trx);
  }

  /** A new invite invalidates the previous link (resend invite). */
  async issueInvite(userId: string, trx: DbTransaction): Promise<{ token: string; expiresAt: Date }> {
    const now = this.clock.now();
    await this.codes.consumeAllActive(userId, VerificationPurpose.ACCOUNT_INVITE, now, trx);
    const token = randomToken(OPAQUE_TOKEN_BYTES);
    const expiresAt = addDuration(now, this.env.INVITE_TTL_HOURS, TimeUnit.HOUR);
    await this.codes.insert(
      {
        userId,
        purpose: VerificationPurpose.ACCOUNT_INVITE,
        codeHash: sha256Hex(token),
        expiresAt,
        createdAt: now,
      },
      trx,
    );
    return { token, expiresAt };
  }

  /** The open, unexpired invite for `token` (locked FOR UPDATE), or undefined. */
  async findUsableInvite(token: string, trx: DbTransaction): Promise<VerificationCode | undefined> {
    if (!OPAQUE_TOKEN_PATTERN.test(token)) return undefined;
    const invite = await this.codes.findUnconsumedInviteByHash(sha256Hex(token), trx, { forUpdate: true });
    // Invites have no attempt counter: any max > 0 keeps the check to "open and unexpired".
    return invite?.isUsable(this.clock.now(), Number.POSITIVE_INFINITY) ? invite : undefined;
  }
}
