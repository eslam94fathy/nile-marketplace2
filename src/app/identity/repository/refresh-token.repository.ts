import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { IDENTITY_TABLES } from '../constants';
import { RefreshToken } from '../model/refresh-token.model';

const T = IDENTITY_TABLES.REFRESH_TOKENS;
const COLUMNS = [
  'id',
  'user_id',
  'family_id',
  'token_hash',
  'expires_at',
  'revoked_at',
  'replaced_by_id',
  'user_agent',
  'created_at',
] as const;

interface RefreshTokenRow {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by_id: string | null;
  user_agent: string | null;
  created_at: Date;
}

export interface NewRefreshToken {
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent: string | null;
  createdAt: Date;
}

function toModel(row: RefreshTokenRow): RefreshToken {
  return new RefreshToken({
    id: row.id,
    userId: row.user_id,
    familyId: row.family_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    replacedById: row.replaced_by_id,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  });
}

@injectable()
export class RefreshTokenRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async insert(token: NewRefreshToken, trx: DbTransaction): Promise<RefreshToken> {
    const [row] = await trx<RefreshTokenRow>(T)
      .insert({
        user_id: token.userId,
        family_id: token.familyId,
        token_hash: token.tokenHash,
        expires_at: token.expiresAt,
        user_agent: token.userAgent,
        created_at: token.createdAt,
      })
      .returning(COLUMNS);
    if (!row) throw new Error('refresh_tokens insert returned no row');
    return toModel(row);
  }

  /** `forUpdate` serialises concurrent refreshes of the same token. */
  async findByHash(
    tokenHash: string,
    trx?: DbTransaction,
    options: { forUpdate?: boolean } = {},
  ): Promise<RefreshToken | undefined> {
    const query = this.exec(trx)<RefreshTokenRow>(T)
      .select(...COLUMNS)
      .where({ token_hash: tokenHash })
      .first();
    if (options.forUpdate) void query.forUpdate();
    const row = await query;
    return row ? toModel(row) : undefined;
  }

  /** Conditional: false if it was already revoked (a concurrent or repeated use). */
  async revokeIfActive(id: string, at: Date, trx: DbTransaction): Promise<boolean> {
    const count = await trx<RefreshTokenRow>(T)
      .where({ id })
      .whereNull('revoked_at')
      .update({ revoked_at: at });
    return count === 1;
  }

  async setReplacedBy(id: string, replacedById: string, trx: DbTransaction): Promise<void> {
    await trx<RefreshTokenRow>(T).where({ id }).update({ replaced_by_id: replacedById });
  }

  /** Reuse detected / logout: revoke every live token of the family. */
  async revokeFamily(familyId: string, at: Date, trx?: DbTransaction): Promise<number> {
    return this.exec(trx)<RefreshTokenRow>(T)
      .where({ family_id: familyId })
      .whereNull('revoked_at')
      .update({ revoked_at: at });
  }

  /** Suspend / password reset: every session. Password change keeps the caller's family. */
  async revokeAllForUser(
    userId: string,
    at: Date,
    trx: DbTransaction,
    options: { exceptFamilyId?: string } = {},
  ): Promise<number> {
    const query = trx<RefreshTokenRow>(T).where({ user_id: userId }).whereNull('revoked_at');
    if (options.exceptFamilyId) void query.whereNot({ family_id: options.exceptFamilyId });
    return query.update({ revoked_at: at });
  }

  /** Retention cleanup (D-4 index): returns the number deleted, at most `limit` per call. */
  async deleteExpiredBefore(cutoff: Date, limit: number): Promise<number> {
    const result = await this.db.knex.raw<{ rowCount: number }>(
      `DELETE FROM ${T} WHERE id IN (SELECT id FROM ${T} WHERE expires_at < ? LIMIT ?)`,
      [cutoff, limit],
    );
    return result.rowCount;
  }
}
