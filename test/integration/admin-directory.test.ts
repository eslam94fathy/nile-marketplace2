import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { startTestApp, type TestApp } from '../helpers/test-app';

interface UserItem {
  id: string;
  email: string;
  role: string;
  status: string;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

interface CustomerItem {
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  userStatus: string;
  createdAt: string;
  addressCount?: number;
}

const HASH = '$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234';

/* Spec 20 §3.3 (BO-17…BO-19): the admin user and customer directories. */
describe('admin user and customer directory', () => {
  let t: TestApp;
  let adminToken: string;
  const knex = () => t.infra.db.knex;
  /** Unique per run, so filters only see this file's rows. */
  const tag = randomUUID().slice(0, 8);

  const get = (path: string, token = adminToken) =>
    request(t.app).get(`${API}${path}`).set('Authorization', `Bearer ${token}`);

  async function insertUser(email: string, role: string, status = 'active'): Promise<string> {
    const [row] = await knex()('users')
      .insert({ email, password_hash: HASH, role, status })
      .returning<{ id: string }[]>('id');
    if (!row) throw new Error('fixture');
    return row.id;
  }

  async function insertCustomer(email: string, firstName: string, lastName: string, phone: string) {
    const userId = await insertUser(email, 'customer');
    const [row] = await knex()('customers')
      .insert({ user_id: userId, first_name: firstName, last_name: lastName, phone })
      .returning<{ id: string }[]>('id');
    if (!row) throw new Error('fixture');
    return { customerId: row.id, userId };
  }

  beforeAll(async () => {
    t = await startTestApp();
    const adminId = await insertUser(`admin-${tag}@example.com`, 'admin');
    adminToken = await signTestAccessToken({ sub: adminId, role: 'admin' });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('GET /admin/users', () => {
    it('lists every role, filters by role, status and email prefix, newest first', async () => {
      const seller = await insertUser(`dir-${tag}-seller@example.com`, 'seller');
      const agent = await insertUser(`dir-${tag}-agent@example.com`, 'delivery_agent', 'suspended');
      const customer = await insertUser(`dir-${tag}-customer@example.com`, 'customer');

      const byPrefix = await get(`/admin/users?email[like]=DIR-${tag}`);
      expect(byPrefix.status).toBe(200);
      const items = successBody<UserItem[]>(byPrefix).data;
      expect(items.map((u) => u.id)).toEqual([customer, agent, seller]);
      expect(items[1]).toMatchObject({
        email: `dir-${tag}-agent@example.com`,
        role: 'delivery_agent',
        status: 'suspended',
        emailVerifiedAt: null,
        lastLoginAt: null,
      });

      // A prefix, not a contains match; LIKE wildcards are literal.
      expect(successBody<UserItem[]>(await get(`/admin/users?email[like]=${tag}`)).data).toEqual([]);
      expect(successBody<UserItem[]>(await get(`/admin/users?email[like]=dir-%25`)).data).toEqual([]);

      const sellers = await get(`/admin/users?email[like]=dir-${tag}&role[eq]=seller`);
      expect(successBody<UserItem[]>(sellers).data.map((u) => u.id)).toEqual([seller]);
      const suspended = await get(`/admin/users?email[like]=dir-${tag}&status[in]=suspended,invited`);
      expect(successBody<UserItem[]>(suspended).data.map((u) => u.id)).toEqual([agent]);
      const oldest = await get(`/admin/users?email[like]=dir-${tag}&sort=createdAt`);
      expect(successBody<UserItem[]>(oldest).data.map((u) => u.id)).toEqual([seller, agent, customer]);
    });

    it('pages with a cursor without skipping or repeating rows', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(await insertUser(`page-${tag}-${i}@example.com`, 'customer'));
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await get(
          `/admin/users?email[like]=page-${tag}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        const { data, meta } = successBody<UserItem[]>(res);
        seen.push(...data.map((u) => u.id));
        cursor = meta?.hasMore ? meta.nextCursor : null;
      } while (cursor);
      expect(seen).toEqual([...ids].reverse());
    });

    it('validation and authz', async () => {
      expect((await get('/admin/users?role[eq]=moderator')).status).toBe(400);
      expect((await get('/admin/users?email[eq]=a@example.com')).status).toBe(400);
      expect((await get('/admin/users?sort=email')).status).toBe(400);
      const customer = await insertUser(`authz-${tag}@example.com`, 'customer');
      const token = await signTestAccessToken({ sub: customer, role: 'customer' });
      expect((await get('/admin/users', token)).status).toBe(403);
      expect((await request(t.app).get(`${API}/admin/users`)).status).toBe(401);
    });
  });

  describe('GET /admin/customers', () => {
    it('filters by name (contains, first or last) and phone, with email and user status', async () => {
      const mona = await insertCustomer(`mona-${tag}@example.com`, 'Mona', `Zaki${tag}`, '+201001110001');
      const omar = await insertCustomer(`omar-${tag}@example.com`, 'Omar', `Zaki${tag}`, '+201001110002');
      await knex()('users').where({ id: omar.userId }).update({ status: 'suspended' });

      const byLast = await get(`/admin/customers?name[like]=zaki${tag}`);
      expect(byLast.status).toBe(200);
      const items = successBody<CustomerItem[]>(byLast).data;
      expect(items.map((c) => c.id)).toEqual([omar.customerId, mona.customerId]);
      expect(items[0]).toMatchObject({
        userId: omar.userId,
        email: `omar-${tag}@example.com`,
        firstName: 'Omar',
        phone: '+201001110002',
        userStatus: 'suspended',
      });
      const byFull = await get(`/admin/customers?name[like]=${encodeURIComponent(`mona zaki${tag}`)}`);
      expect(successBody<CustomerItem[]>(byFull).data.map((c) => c.id)).toEqual([mona.customerId]);
      const byPhone = await get(`/admin/customers?phone[eq]=${encodeURIComponent('+201001110001')}`);
      expect(successBody<CustomerItem[]>(byPhone).data.map((c) => c.id)).toEqual([mona.customerId]);
    });

    it('detail adds the live address count; 404 unknown', async () => {
      const { customerId } = await insertCustomer(`addr-${tag}@example.com`, 'Hana', 'Adel', '+201001110003');
      const governorate = await knex()('governorates').first<{ id: string }>('id');
      const address = (label: string, deleted: boolean) => ({
        customer_id: customerId,
        governorate_id: governorate.id,
        label,
        recipient_name: 'Hana Adel',
        recipient_phone: '+201001110003',
        city: 'Cairo',
        area: 'Maadi',
        street: 'Road 9',
        building: '12',
        floor: '3',
        apartment: null,
        landmark: null,
        is_default: false,
        deleted_at: deleted ? new Date() : null,
      });
      await knex()('customer_addresses').insert([address('Home', false), address('Old', true)]);

      const res = await get(`/admin/customers/${customerId}`);
      expect(res.status).toBe(200);
      expect(successBody<CustomerItem>(res).data).toMatchObject({
        id: customerId,
        email: `addr-${tag}@example.com`,
        userStatus: 'active',
        addressCount: 1,
      });

      const missing = await get('/admin/customers/0192f5e0-0000-7000-8000-000000000000');
      expect(missing.status).toBe(404);
      expect(errorBody(missing).error.code).toBe('CUSTOMER_NOT_FOUND');
    });

    it('validation and authz', async () => {
      expect((await get('/admin/customers?name[eq]=Mona')).status).toBe(400);
      expect((await get('/admin/customers?email[like]=mona')).status).toBe(400);
      expect((await get('/admin/customers?createdAt[gte]=2026-01-01')).status).toBe(400);
      expect((await get('/admin/customers/not-a-uuid')).status).toBe(400);
      const seller = await insertUser(`authz2-${tag}@example.com`, 'seller');
      const token = await signTestAccessToken({ sub: seller, role: 'seller' });
      expect((await get('/admin/customers', token)).status).toBe(403);
    });
  });
});
