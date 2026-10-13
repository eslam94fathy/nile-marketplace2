import { inject, injectable } from 'tsyringe';
import { type UserRole } from '../../../lib/auth';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { IDENTITY_TABLES } from '../constants';
import { type UserStatus } from '../enums';
import { User } from '../model/user.model';

const T = IDENTITY_TABLES.USERS;
const COLUMNS = [
  'id',
  'email',
  'password_hash',
  'role',
  'status',
  'email_verified_at',
  'last_login_at',
  'created_at',
  'updated_at',
] as const;

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  role: UserRole;
  status: UserStatus;
  email_verified_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface NewUser {
  email: string;
  passwordHash: string | null;
  role: UserRole;
  status: UserStatus;
}

export interface FindOptions {
  /** `SELECT … FOR UPDATE` (requires `trx`). */
  forUpdate?: boolean;
}

function toModel(row: UserRow): User {
  return new User({
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
    emailVerifiedAt: row.email_verified_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

@injectable()
export class UserRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async findById(id: string, trx?: DbTransaction, options: FindOptions = {}): Promise<User | undefined> {
    const query = this.exec(trx)<UserRow>(T)
      .select(...COLUMNS)
      .where({ id })
      .first();
    if (options.forUpdate) void query.forUpdate();
    const row = await query;
    return row ? toModel(row) : undefined;
  }

  /** `email` must already be normalised (trimmed, lower-case). */
  async findByEmail(
    email: string,
    trx?: DbTransaction,
    options: FindOptions = {},
  ): Promise<User | undefined> {
    const query = this.exec(trx)<UserRow>(T)
      .select(...COLUMNS)
      .where({ email })
      .first();
    if (options.forUpdate) void query.forUpdate();
    const row = await query;
    return row ? toModel(row) : undefined;
  }

  /** EXISTS check (G22): the seed CLI refuses an existing email with a friendly message. */
  async existsByEmail(email: string, trx?: DbTransaction): Promise<boolean> {
    const result = await this.exec(trx).raw<{ rows: { exists: boolean }[] }>(
      `SELECT EXISTS (SELECT 1 FROM ${T} WHERE email = ?) AS "exists"`,
      [email],
    );
    return result.rows[0]?.exists === true;
  }

  /**
   * One page of users of a role (admin lists). Filters and sort come from the endpoint whitelist.
   * Returns `limit + 1` rows at most (`toPage` trims and builds the cursor).
   */
  async listByRole(role: UserRole, query: ParsedListQuery, trx?: DbTransaction): Promise<User[]> {
    const qb = this.exec(trx)<UserRow>(T)
      .select(...COLUMNS)
      .where({ role });
    const rows = (await applyListQuery(qb, query, 'id')) as UserRow[];
    return rows.map(toModel);
  }

  /** Batched lookup for other modules (no N+1, G20). */
  async findByIds(ids: readonly string[], trx?: DbTransaction): Promise<User[]> {
    if (ids.length === 0) return [];
    const rows = await this.exec(trx)<UserRow>(T)
      .select(...COLUMNS)
      .whereIn('id', [...new Set(ids)]);
    return rows.map(toModel);
  }

  async insert(user: NewUser, trx: DbTransaction): Promise<User> {
    const [row] = await trx<UserRow>(T)
      .insert({ email: user.email, password_hash: user.passwordHash, role: user.role, status: user.status })
      .returning(COLUMNS);
    if (!row) throw new Error('users insert returned no row');
    return toModel(row);
  }

  /**
   * Conditional status change (no read-then-write race, CLAUDE.md §6.4).
   * Returns the updated user, or undefined if its status was not one of `from`.
   */
  async transitionStatus(
    id: string,
    from: readonly UserStatus[],
    to: UserStatus,
    trx: DbTransaction,
    extra: { emailVerifiedAt?: Date; passwordHash?: string } = {},
  ): Promise<User | undefined> {
    const [row] = await trx<UserRow>(T)
      .where({ id })
      .whereIn('status', [...from])
      .update({
        status: to,
        ...(extra.emailVerifiedAt ? { email_verified_at: extra.emailVerifiedAt } : {}),
        ...(extra.passwordHash ? { password_hash: extra.passwordHash } : {}),
        updated_at: trx.fn.now(),
      })
      .returning(COLUMNS);
    return row ? toModel(row) : undefined;
  }

  async updatePasswordHash(id: string, passwordHash: string, trx: DbTransaction): Promise<boolean> {
    const count = await trx<UserRow>(T)
      .where({ id })
      .update({ password_hash: passwordHash, updated_at: trx.fn.now() });
    return count === 1;
  }

  /** Conditional on the hash the caller verified: false if the password changed meanwhile. */
  async replacePasswordHash(
    id: string,
    expectedHash: string,
    passwordHash: string,
    trx: DbTransaction,
  ): Promise<boolean> {
    const count = await trx<UserRow>(T)
      .where({ id, password_hash: expectedHash })
      .update({ password_hash: passwordHash, updated_at: trx.fn.now() });
    return count === 1;
  }

  async touchLastLogin(id: string, at: Date, trx: DbTransaction): Promise<void> {
    await trx<UserRow>(T).where({ id }).update({ last_login_at: at, updated_at: trx.fn.now() });
  }
}
