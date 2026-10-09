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
    it('idx_users_role_created_at (DB-Q6) is valid and serves the admin list keyset query', async () => {
      const index = await db.raw<{ rows: { valid: boolean; definition: string }[] }>(
        `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS definition
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'idx_users_role_created_at'`,
      );
      expect(index.rows[0]?.valid).toBe(true);
      expect(index.rows[0]?.definition).toContain('(role, created_at DESC, id DESC)');

      // The table is tiny here, so forbid the seq scan to see that the planner can use the index.
      const plan = await db.transaction(async (trx) => {
        await trx.raw('SET LOCAL enable_seqscan = off');
        const result = await trx.raw<{ rows: { 'QUERY PLAN': string }[] }>(
          `EXPLAIN SELECT id FROM users WHERE role = 'admin'
             AND (created_at, id) < (now(), '0192f5e0-0000-7000-8000-000000000000')
             ORDER BY created_at DESC, id DESC LIMIT 21`,
        );
        return result.rows.map((row) => row['QUERY PLAN']).join('\n');
      });
      expect(plan).toContain('idx_users_role_created_at');
      expect(plan).not.toContain('Sort');
    });

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

  describe('governorates', () => {
    it('seeds the 27 governorates with ISO codes and no fee (spec 11 DE-2)', async () => {
      const rows = await db('governorates').select<{ code: string; delivery_fee: string | null }[]>(
        'code',
        'delivery_fee',
      );
      expect(rows).toHaveLength(27);
      expect(new Set(rows.map((r) => r.code)).size).toBe(27);
      expect(rows.every((r) => r.delivery_fee === null)).toBe(true);
      expect(rows.map((r) => r.code)).toContain('EG-C');
    });

    it('enforces the code format, unique codes and a non-negative fee', async () => {
      const insert = (code: string, fee: string | null = null) =>
        db('governorates').insert({ code, name: 'Test', delivery_fee: fee });
      expect((await pgFailure(() => insert('CAIRO'))).constraint).toBe('chk_governorates_code');
      expect((await pgFailure(() => insert('EG-C'))).constraint).toBe('uq_governorates_code');
      expect(
        (await pgFailure(() => db('governorates').where({ code: 'EG-C' }).update({ delivery_fee: '-1' })))
          .constraint,
      ).toBe('chk_governorates_delivery_fee');
    });
  });

  describe('delivery_settings', () => {
    it('holds exactly one seeded row (0.7000) and refuses a second one or a rate over 1', async () => {
      const rows =
        await db('delivery_settings').select<{ agent_fee_share_rate: string }[]>('agent_fee_share_rate');
      expect(rows).toEqual([{ agent_fee_share_rate: '0.7000' }]);
      expect(
        (
          await pgFailure(() =>
            db('delivery_settings').insert({ is_singleton: true, agent_fee_share_rate: 0.5 }),
          )
        ).constraint,
      ).toBe('uq_delivery_settings_is_singleton');
      expect(
        (
          await pgFailure(() =>
            db('delivery_settings').insert({ is_singleton: false, agent_fee_share_rate: 0.5 }),
          )
        ).constraint,
      ).toBe('chk_delivery_settings_is_singleton');
      expect(
        (await pgFailure(() => db('delivery_settings').update({ agent_fee_share_rate: 1.5 }))).constraint,
      ).toBe('chk_delivery_settings_agent_fee_share_rate');
    });
  });
});
