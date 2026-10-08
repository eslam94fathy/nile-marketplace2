import { randomUUID } from 'node:crypto';
import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDownAll, migrateLatest } from '../../src/lib/db/migrator';
import { MIGRATIONS } from '../../src/migrations';
import { createTestResources, type TestResources } from '../helpers/test-resources';

const HASH = (char: string) => char.repeat(64);

/** Runs `fn` and returns the Postgres error code + constraint name it fails with. */
async function pgFailure(fn: () => Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await fn();
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    return { code, constraint };
  }
  throw new Error('expected the statement to fail');
}

describe('migrations on a real Postgres 18', () => {
  let resources: TestResources;
  let db: Knex;

  const user = (overrides: Record<string, unknown> = {}) => ({
    email: `${randomUUID()}@example.com`,
    password_hash: '$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234',
    role: 'customer',
    status: 'active',
    ...overrides,
  });
  const insertUser = async (overrides: Record<string, unknown> = {}) =>
    (await db('users').insert(user(overrides)).returning<{ id: string }[]>('id'))[0]?.id ?? '';

  beforeAll(async () => {
    resources = await createTestResources();
    db = knex({ client: 'pg', connection: resources.env.DATABASE_URL });
  });
  afterAll(async () => {
    await db.destroy();
    await resources.cleanup();
  });

  it('every migration rolls back and re-applies cleanly (CLAUDE.md §6.1: working downs)', async () => {
    const reverted = await migrateDownAll(db, MIGRATIONS);
    expect(reverted).toHaveLength(MIGRATIONS.length);
    const tables = await db.raw<{ rows: unknown[] }>(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE 'knex_%'`,
    );
    expect(tables.rows).toHaveLength(0);
    expect(await migrateLatest(db, MIGRATIONS)).toHaveLength(MIGRATIONS.length);
  });

  describe('users', () => {
    it('stores lower-case emails only, unique', async () => {
      expect(await pgFailure(() => insertUser({ email: 'Mixed@Example.com' }))).toEqual({
        code: '23514',
        constraint: 'chk_users_email_lowercase',
      });
      const email = `${randomUUID()}@example.com`;
      await insertUser({ email });
      expect(await pgFailure(() => insertUser({ email }))).toEqual({
        code: '23505',
        constraint: 'uq_users_email',
      });
    });

    it('only invited accounts may lack a password hash', async () => {
      await expect(insertUser({ status: 'invited', password_hash: null })).resolves.toBeTruthy();
      expect(await pgFailure(() => insertUser({ status: 'active', password_hash: null }))).toEqual({
        code: '23514',
        constraint: 'chk_users_password_hash_required',
      });
    });

    it('whitelists role and status, and has no defaults on business columns (G13)', async () => {
      expect((await pgFailure(() => insertUser({ role: 'moderator' }))).constraint).toBe('chk_users_role');
      expect((await pgFailure(() => insertUser({ status: 'deleted' }))).constraint).toBe('chk_users_status');
      const { role: _role, ...withoutRole } = user();
      expect((await pgFailure(() => db('users').insert(withoutRole))).code).toBe('23502'); // NOT NULL
    });
  });

  describe('refresh_tokens and verification_codes', () => {
    it('require hex SHA-256 hashes; refresh token hashes are unique', async () => {
      const userId = await insertUser();
      const token = (hash: string) => ({
        user_id: userId,
        family_id: randomUUID(),
        token_hash: hash,
        expires_at: new Date(Date.now() + 60_000),
      });
      expect((await pgFailure(() => db('refresh_tokens').insert(token('not-hex')))).code).toBe('23514');
      await db('refresh_tokens').insert(token(HASH('a')));
      expect(await pgFailure(() => db('refresh_tokens').insert(token(HASH('a'))))).toEqual({
        code: '23505',
        constraint: 'uq_refresh_tokens_token_hash',
      });
    });

    it('invite token hashes are unique, OTP hashes need not be', async () => {
      const userId = await insertUser();
      const code = (purpose: string, hash: string) => ({
        user_id: userId,
        purpose,
        code_hash: hash,
        expires_at: new Date(Date.now() + 60_000),
        attempts: 0,
      });
      await db('verification_codes').insert([
        code('email_verification', HASH('b')),
        code('password_reset', HASH('b')),
      ]);
      await db('verification_codes').insert(code('account_invite', HASH('c')));
      expect(
        await pgFailure(() => db('verification_codes').insert(code('account_invite', HASH('c')))),
      ).toEqual({ code: '23505', constraint: 'uq_verification_codes_code_hash' });
      expect(
        (await pgFailure(() => db('verification_codes').insert(code('login', HASH('d'))))).constraint,
      ).toBe('chk_verification_codes_purpose');
    });

    it('deleting a user cascades to its tokens and codes; replaced_by_id is set null on delete', async () => {
      const userId = await insertUser();
      const [first] = await db('refresh_tokens')
        .insert({
          user_id: userId,
          family_id: randomUUID(),
          token_hash: HASH('e'),
          expires_at: new Date(Date.now() + 60_000),
        })
        .returning<{ id: string }[]>('id');
      const [second] = await db('refresh_tokens')
        .insert({
          user_id: userId,
          family_id: randomUUID(),
          token_hash: HASH('f'),
          expires_at: new Date(Date.now() + 60_000),
        })
        .returning<{ id: string }[]>('id');
      await db('refresh_tokens').where({ id: first?.id }).update({ replaced_by_id: second?.id });

      await db('refresh_tokens').where({ id: second?.id }).delete();
      expect(
        (await db('refresh_tokens').where({ id: first?.id }).first<{ replaced_by_id: string | null }>())
          ?.replaced_by_id,
      ).toBeNull();

      await db('verification_codes').insert({
        user_id: userId,
        purpose: 'password_reset',
        code_hash: HASH('9'),
        expires_at: new Date(Date.now() + 60_000),
        attempts: 0,
      });
      await db('users').where({ id: userId }).delete();
      expect(await db('refresh_tokens').where({ user_id: userId })).toHaveLength(0);
      expect(await db('verification_codes').where({ user_id: userId })).toHaveLength(0);
    });
  });
});
