import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdentityJobs } from '../../src/app/identity';
import { createWorkerContainer } from '../../src/container';
import { type WorkerInfrastructure } from '../../src/infrastructure';
import { runSeedAdmin } from '../../src/seed-admin-command';
import { API, identityFixtures, newEmail, PASSWORD } from '../helpers/identity';
import { createMemoryLogger } from '../helpers/memory-logger';
import { startTestApp, type TestApp } from '../helpers/test-app';
import { startTestWorkerInfra, type TestInfra } from '../helpers/test-infra';

describe('seed-admin CLI (UC-ID-8, P1-Q7)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const seed = async (argv: string[]) => {
    const { logger, writer } = createMemoryLogger();
    const code = await runSeedAdmin(argv, t.resources.seedAdminEnv, logger);
    return { code, entries: writer.entries(), lines: writer.lines.join('\n') };
  };

  it('creates an invited admin whose invite can be accepted; never logs the token', async () => {
    const email = newEmail();
    const run = await seed(['--email', ` ${email.toUpperCase()} `]);
    expect(run.code).toBe(0);

    const user = await t.infra.db
      .knex('users')
      .where({ email })
      .first<{ id: string; role: string; status: string } | undefined>('id', 'role', 'status');
    expect(user).toMatchObject({ role: 'admin', status: 'invited' });

    const token = await identityFixtures(t).inviteToken(user?.id ?? '');
    expect(run.lines).not.toContain(token);
    const accept = await request(t.app).post(`${API}/auth/invite/accept`).send({ token, password: PASSWORD });
    expect(accept.status).toBe(200);
  });

  it('refuses an existing email, a bad email and a missing flag (exit code 1)', async () => {
    const email = newEmail();
    expect((await seed([`--email=${email}`])).code).toBe(0);

    const duplicate = await seed(['--email', email]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.entries.some((e) => e.code === 'EMAIL_ALREADY_REGISTERED')).toBe(true);

    expect((await seed(['--email', 'not-an-email'])).code).toBe(1);
    expect((await seed([])).code).toBe(1);
  });
});

describe('expired-codes-cleanup job (architecture §6)', () => {
  let t: TestInfra<WorkerInfrastructure>;

  beforeAll(async () => {
    // testEnvInput: CODES_RETENTION_DAYS = 30.
    t = await startTestWorkerInfra();
  });
  afterAll(async () => {
    await t.close();
  });

  const daysAgo = (days: number) => t.infra.db.knex.raw(`now() - make_interval(days => ?)`, [days]);

  it('deletes codes and refresh tokens that expired before the retention period, keeps the rest', async () => {
    const knex = t.infra.db.knex;
    const [user] = await knex('users')
      .insert({ email: newEmail(), password_hash: 'x'.repeat(60), role: 'customer', status: 'active' })
      .returning<{ id: string }[]>('id');
    const userId = user?.id ?? '';
    const code = (expiresAt: unknown) => ({
      user_id: userId,
      purpose: 'password_reset',
      code_hash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      expires_at: expiresAt,
      attempts: 0,
      created_at: daysAgo(40),
    });
    const token = (expiresAt: unknown, revoked: boolean) => ({
      user_id: userId,
      family_id: randomUUID(),
      token_hash: randomUUID().replace(/-/g, '').padEnd(64, '1'),
      expires_at: expiresAt,
      revoked_at: revoked ? daysAgo(35) : null,
      user_agent: null,
      created_at: daysAgo(40),
    });
    await knex('verification_codes').insert([code(daysAgo(31)), code(daysAgo(29)), code(daysAgo(-1))]);
    await knex('refresh_tokens').insert([
      token(daysAgo(31), true),
      token(daysAgo(31), false),
      token(daysAgo(1), true),
    ]);

    const [job] = createIdentityJobs(createWorkerContainer(t.infra), t.infra.env);
    expect(job?.name).toBe('expired-codes-cleanup');
    // 1 code + 2 tokens expired more than 30 days ago.
    expect(await job?.run()).toBe(3);

    expect((await knex('verification_codes').where({ user_id: userId })).length).toBe(2);
    expect((await knex('refresh_tokens').where({ user_id: userId })).length).toBe(1);
    expect(await job?.run()).toBe(0);
  });
});
