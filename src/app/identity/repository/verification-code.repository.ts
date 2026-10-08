import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { IDENTITY_TABLES } from '../constants';
import { VerificationPurpose } from '../enums';
import { VerificationCode } from '../model/verification-code.model';

const T = IDENTITY_TABLES.VERIFICATION_CODES;
const COLUMNS = [
  'id',
  'user_id',
  'purpose',
  'code_hash',
  'expires_at',
  'attempts',
  'consumed_at',
  'created_at',
] as const;

interface VerificationCodeRow {
  id: string;
  user_id: string;
  purpose: VerificationPurpose;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  consumed_at: Date | null;
  created_at: Date;
}

export interface NewVerificationCode {
  userId: string;
  purpose: VerificationPurpose;
  codeHash: string;
  expiresAt: Date;
  createdAt: Date;
}

function toModel(row: VerificationCodeRow): VerificationCode {
  return new VerificationCode({
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    codeHash: row.code_hash,
    expiresAt: row.expires_at,
    attempts: row.attempts,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  });
}

@injectable()
export class VerificationCodeRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async insert(code: NewVerificationCode, trx: DbTransaction): Promise<VerificationCode> {
    const [row] = await trx<VerificationCodeRow>(T)
      .insert({
        user_id: code.userId,
        purpose: code.purpose,
        code_hash: code.codeHash,
        expires_at: code.expiresAt,
        attempts: 0,
        created_at: code.createdAt,
      })
      .returning(COLUMNS);
    if (!row) throw new Error('verification_codes insert returned no row');
    return toModel(row);
  }

  /** The latest unconsumed code: only this one is accepted (a new code invalidates older ones). */
  async findLatestActive(
    userId: string,
    purpose: VerificationPurpose,
    trx?: DbTransaction,
    options: { forUpdate?: boolean } = {},
  ): Promise<VerificationCode | undefined> {
    const query = this.exec(trx)<VerificationCodeRow>(T)
      .select(...COLUMNS)
      .where({ user_id: userId, purpose })
      .whereNull('consumed_at')
      .orderBy('created_at', 'desc')
      .first();
    if (options.forUpdate) void query.forUpdate();
    const row = await query;
    return row ? toModel(row) : undefined;
  }

  async findUnconsumedInviteByHash(
    codeHash: string,
    trx: DbTransaction,
    options: { forUpdate?: boolean } = {},
  ): Promise<VerificationCode | undefined> {
    const query = trx<VerificationCodeRow>(T)
      .select(...COLUMNS)
      .where({ code_hash: codeHash, purpose: VerificationPurpose.ACCOUNT_INVITE })
      .whereNull('consumed_at')
      .first();
    if (options.forUpdate) void query.forUpdate();
    const row = await query;
    return row ? toModel(row) : undefined;
  }

  async incrementAttempts(id: string, trx: DbTransaction): Promise<void> {
    await trx<VerificationCodeRow>(T)
      .where({ id })
      .update({ attempts: trx.raw('attempts + 1') });
  }

  /** Conditional: false if it was already consumed. */
  async consume(id: string, at: Date, trx: DbTransaction): Promise<boolean> {
    const count = await trx<VerificationCodeRow>(T)
      .where({ id })
      .whereNull('consumed_at')
      .update({ consumed_at: at });
    return count === 1;
  }

  /** Invalidates every open code of a purpose (e.g. a re-sent invite replaces the old link). */
  async consumeAllActive(
    userId: string,
    purpose: VerificationPurpose,
    at: Date,
    trx: DbTransaction,
  ): Promise<number> {
    return trx<VerificationCodeRow>(T)
      .where({ user_id: userId, purpose })
      .whereNull('consumed_at')
      .update({ consumed_at: at });
  }

  /** Retention cleanup: expired codes older than the cutoff, at most `limit` per call. */
  async deleteExpiredBefore(cutoff: Date, limit: number): Promise<number> {
    const result = await this.db.knex.raw<{ rowCount: number }>(
      `DELETE FROM ${T} WHERE id IN (SELECT id FROM ${T} WHERE expires_at < ? LIMIT ?)`,
      [cutoff, limit],
    );
    return result.rowCount;
  }
}
