import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuditJobs, registerAuditWorker } from '../../src/app/audit';
import { type AuditEntryDto } from '../../src/app/audit/dto/audit-response.dto';
import { AUDIT_ACTION_NAMES } from '../../src/lib/audit';
import { type PageMeta } from '../../src/lib/http';
import { runSeedAdmin } from '../../src/seed-admin-command';
import { errorBody, successBody } from '../helpers/http';
import { API, newEmail } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { createMemoryLogger } from '../helpers/memory-logger';
import { sellerFixtures } from '../helpers/sellers';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_ID = '0192f5e0-0000-7000-8000-000000000000';
const CORRELATION_ID = '0192f5e0-1111-7000-8000-00000000c0de';

interface AuditRow {
  id: string;
  actor_type: string;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  changes: { before: Record<string, unknown>; after: Record<string, unknown> } | null;
  reason: string | null;
  correlation_id: string | null;
  ip: string | null;
}

/* Spec 20 §2: the audit log over HTTP and in the database (R-19, BO-2). */
describe('audit log', () => {
  let t: TestApp;
  let fx: ReturnType<typeof sellerFixtures>;
  let admin: { userId: string; email: string; token: string };

  const asAdmin = () => ({
    get: (path: string) => request(t.app).get(`${API}${path}`).set('Authorization', `Bearer ${admin.token}`),
    post: (path: string, body?: object) =>
      request(t.app)
        .post(`${API}${path}`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('X-Correlation-Id', CORRELATION_ID)
        .send(body),
  });
  const rowsFor = (targetId: string) =>
    t.infra.db.knex('admin_audit_log').where({ target_id: targetId }).orderBy('id').select<AuditRow[]>('*');

  beforeAll(async () => {
    t = await startTestApp({ envOverrides: { RATE_LIMIT_STRICT_AUTH_POINTS: '10000' } });
    fx = sellerFixtures(t);
    const active = await fx.createActiveAdmin();
    admin = { userId: active.userId, email: active.email, token: active.session.accessToken };
  });
  afterAll(async () => {
    await t.close();
  });

  it('the action CHECK lists exactly the actions of the catalogue', async () => {
    const row = await t.infra.db.knex
      .raw<{ rows: { def: string }[] }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_admin_audit_log_action'`,
      )
      .then((result) => result.rows[0]);
    const listed = [...(row?.def ?? '').matchAll(/'([a-z_.]+)'/g)].map((match) => match[1]).sort();
    expect(listed).toEqual([...AUDIT_ACTION_NAMES].sort());
  });

  it('an admin write records actor, IP, correlation id, target and the changed fields in its transaction', async () => {
    const seller = await fx.createVerifiedSeller();
    expect((await asAdmin().post(`/admin/sellers/${seller.sellerId}/approve`)).status).toBe(200);
    expect(
      (await asAdmin().post(`/admin/sellers/${seller.sellerId}/suspend`, { reason: 'fake documents' }))
        .status,
    ).toBe(200);

    const rows = await rowsFor(seller.sellerId);
    expect(rows.map((row) => row.action)).toEqual(['seller.approved', 'seller.suspended']);
    expect(rows[1]).toMatchObject({
      actor_type: 'admin',
      actor_user_id: admin.userId,
      target_type: 'seller',
      changes: { before: { status: 'approved' }, after: { status: 'suspended' } },
      reason: 'fake documents',
      correlation_id: CORRELATION_ID,
    });
    expect(rows[1]?.ip).toMatch(/127\.0\.0\.1|::1/);
  });

  it('a refused admin write leaves no audit row (same transaction)', async () => {
    const seller = await fx.createVerifiedSeller();
    // pending_approval can't be suspended → 409, rolled back.
    const res = await asAdmin().post(`/admin/sellers/${seller.sellerId}/suspend`, { reason: 'too early' });
    expect(res.status).toBe(409);
    expect(await rowsFor(seller.sellerId)).toEqual([]);
  });

  it('rows are append-only: an UPDATE is rejected by the trigger', async () => {
    const seller = await fx.createVerifiedSeller();
    await asAdmin().post(`/admin/sellers/${seller.sellerId}/approve`);
    const [row] = await rowsFor(seller.sellerId);
    await expect(
      t.infra.db.knex('admin_audit_log').where({ id: row?.id }).update({ reason: 'tampered' }),
    ).rejects.toThrow(/append-only/);
  });

  it('a setting change has no target id and records the old and new value', async () => {
    const res = await request(t.app)
      .put(`${API}/admin/settings/commission`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ defaultCommissionRate: '0.1500' });
    expect(res.status).toBe(200);
    const row = await t.infra.db
      .knex('admin_audit_log')
      .where({ action: 'setting.default_commission_changed' })
      .orderBy('id', 'desc')
      .first<AuditRow>('*');
    expect(row).toMatchObject({
      target_type: 'setting',
      target_id: null,
      changes: { before: { defaultCommissionRate: '0.1000' }, after: { defaultCommissionRate: '0.1500' } },
    });
  });

  describe('GET /admin/audit-log', () => {
    it('lists newest first with the actor email; filters by action and by target', async () => {
      const seller = await fx.createVerifiedSeller();
      await asAdmin().post(`/admin/sellers/${seller.sellerId}/approve`);

      const res = await asAdmin().get(
        `/admin/audit-log?targetType[eq]=seller&targetId[eq]=${seller.sellerId}&action[in]=seller.approved,seller.rejected`,
      );
      expect(res.status).toBe(200);
      const body = successBody<AuditEntryDto[]>(res) as { data: AuditEntryDto[]; meta: PageMeta };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        actorType: 'admin',
        actor: { userId: admin.userId, email: admin.email },
        action: 'seller.approved',
        targetType: 'seller',
        targetId: seller.sellerId,
      });

      const detail = await asAdmin().get(`/admin/audit-log/${body.data[0]?.id ?? ''}`);
      expect(successBody<AuditEntryDto>(detail).data.id).toBe(body.data[0]?.id);
    });

    it('pages with a cursor', async () => {
      const first = await asAdmin().get('/admin/audit-log?limit=1');
      const page = successBody<AuditEntryDto[]>(first) as { data: AuditEntryDto[]; meta: PageMeta };
      expect(page.meta.hasMore).toBe(true);
      const second = await asAdmin().get(`/admin/audit-log?limit=1&cursor=${page.meta.nextCursor ?? ''}`);
      const next = successBody<AuditEntryDto[]>(second).data;
      expect(next[0]?.id).not.toBe(page.data[0]?.id);
    });

    it('targetId without targetType, an unknown field or action → 400 INVALID_QUERY', async () => {
      for (const query of [`targetId[eq]=${UNKNOWN_ID}`, 'secret[eq]=1', 'action[eq]=user.deleted']) {
        const res = await asAdmin().get(`/admin/audit-log?${query}`);
        expect(res.status).toBe(400);
        expect(errorBody(res).error.code).toBe('INVALID_QUERY');
      }
    });

    it('unknown entry → 404 AUDIT_ENTRY_NOT_FOUND; a bad id → 400', async () => {
      const missing = await asAdmin().get(`/admin/audit-log/${UNKNOWN_ID}`);
      expect(missing.status).toBe(404);
      expect(errorBody(missing).error.code).toBe('AUDIT_ENTRY_NOT_FOUND');
      expect((await asAdmin().get('/admin/audit-log/not-a-uuid')).status).toBe(400);
    });

    it('401 without a token, 403 for every other role', async () => {
      expect((await request(t.app).get(`${API}/admin/audit-log`)).status).toBe(401);
      for (const role of ['customer', 'seller', 'delivery_agent'] as const) {
        const token = await signTestAccessToken({ role });
        const res = await request(t.app)
          .get(`${API}/admin/audit-log`)
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
      }
    });
  });

  it('seed-admin records admin.seeded with actor type cli', async () => {
    const email = newEmail();
    const { logger } = createMemoryLogger();
    expect(await runSeedAdmin(['--email', email], t.resources.seedAdminEnv, logger)).toBe(0);
    const user = await t.infra.db.knex('users').where({ email }).first<{ id: string }>('id');
    const [row] = await rowsFor(user.id);
    expect(row).toMatchObject({
      actor_type: 'cli',
      actor_user_id: null,
      action: 'admin.seeded',
      target_type: 'user',
      changes: { before: {}, after: { email, role: 'admin' } },
      ip: null,
    });
    expect(row?.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('audit-retention deletes rows older than the retention period, in batches', async () => {
    const old = new Date(Date.now() - 800 * 24 * 3600 * 1000);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    // Inserted with an old timestamp directly: the app never writes created_at itself.
    await t.infra.db.knex('admin_audit_log').insert(
      ids.map((id) => ({
        id,
        actor_type: 'admin',
        actor_user_id: admin.userId,
        action: 'user.invite_resent',
        target_type: 'user',
        target_id: admin.userId,
        created_at: old,
      })),
    );
    // The job runs in the worker; its only dependencies are the repository and the clock.
    const worker = t.container.createChildContainer();
    registerAuditWorker(worker);
    const [job] = createAuditJobs(worker, { ...t.resources.workerEnv, AUDIT_RETENTION_BATCH_SIZE: 2 });
    expect(await job?.run()).toBeGreaterThanOrEqual(3);
    expect(
      await t.infra.db.knex('admin_audit_log').whereIn('id', ids).count<{ count: string }[]>('*'),
    ).toEqual([{ count: '0' }]);
  });
});
