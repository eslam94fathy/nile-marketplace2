import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IDeliveryAgentDirectory } from '../../src/app/delivery';
import { type AdminAgentDto, type AgentProfileDto } from '../../src/app/delivery/dto/delivery-agent.dto';
import { TOKENS } from '../../src/lib/di';
import { deliveryFixtures } from '../helpers/delivery-fixtures';
import { errorBody, successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { startTestApp, type TestApp } from '../helpers/test-app';

const UNKNOWN_V7_ID = '0192f5e0-0000-7000-8000-000000000000';

/* Spec 11 UC-DE-2, UC-DE-6, §4.2 profile / availability, §4.3 agents, DE-5, DE-11 over HTTP. */
describe('delivery: agents', () => {
  let t: TestApp;
  let fx: ReturnType<typeof deliveryFixtures>;
  let adminToken: string;
  let cairoId: string;

  const knex = () => t.infra.db.knex;
  const as = (token: string | undefined) => {
    const auth = (req: request.Test) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
    return {
      get: (path: string) => auth(request(t.app).get(`${API}${path}`)),
      post: (path: string, body?: object) => auth(request(t.app).post(`${API}${path}`)).send(body),
      patch: (path: string, body?: object) => auth(request(t.app).patch(`${API}${path}`)).send(body),
    };
  };
  const userStatus = async (userId: string) =>
    (await knex()('users').where({ id: userId }).first<{ status: string }>('status')).status;
  const newAgentBody = (overrides: Record<string, unknown> = {}) => ({
    email: `agent-${randomUUID()}@example.com`,
    fullName: 'Karim Hassan',
    phone: '+201101234567',
    homeGovernorateId: cairoId,
    ...overrides,
  });
  /** An agent whose login is active (fixtures), and its token. */
  const activeAgent = async () => {
    const { agentId, userId } = await fx.insertAgent();
    return { agentId, userId, token: await signTestAccessToken({ sub: userId, role: 'delivery_agent' }) };
  };

  beforeAll(async () => {
    t = await startTestApp();
    fx = deliveryFixtures(knex());
    cairoId = await fx.governorateId();
    adminToken = await signTestAccessToken({ sub: await fx.insertUser('admin'), role: 'admin' });
  });
  afterAll(async () => {
    await t.close();
  });

  describe('admin', () => {
    it('creates an agent with an invited login and an invite email; the agent starts active and off shift', async () => {
      const body = newAgentBody();
      const res = await as(adminToken).post('/admin/delivery-agents', body);
      expect(res.status).toBe(201);
      const agent = successBody<AdminAgentDto>(res).data;
      expect(agent).toMatchObject({
        email: body.email,
        fullName: 'Karim Hassan',
        phone: '+201101234567',
        homeGovernorateId: cairoId,
        status: 'active',
        onShift: false,
        activeShipmentCount: 0,
        userStatus: 'invited',
        lastAssignedAt: null,
      });
      const user = await knex()('users')
        .where({ email: body.email })
        .first<{ id: string; role: string }>('id', 'role');
      expect(user.role).toBe('delivery_agent');
      const invite = await knex()('events_outbox')
        .where({ event_type: 'notification.email_requested' })
        .whereRaw(`payload->>'userId' = ?`, [user.id])
        .first<{ payload: { template: string } }>('payload');
      expect(invite?.payload.template).toBe('account_invite');
    });

    it('refuses a taken email, an unknown governorate, bad input and other roles', async () => {
      const body = newAgentBody();
      expect((await as(adminToken).post('/admin/delivery-agents', body)).status).toBe(201);
      const taken = await as(adminToken).post('/admin/delivery-agents', body);
      expect([taken.status, errorBody(taken).error.code]).toEqual([409, 'EMAIL_ALREADY_REGISTERED']);
      const noGovernorate = await as(adminToken).post(
        '/admin/delivery-agents',
        newAgentBody({ homeGovernorateId: UNKNOWN_V7_ID }),
      );
      expect([noGovernorate.status, errorBody(noGovernorate).error.code]).toEqual([
        422,
        'GOVERNORATE_NOT_FOUND',
      ]);
      for (const bad of [{ phone: '0101' }, { fullName: '' }, { email: 'nope' }, { extra: 1 }]) {
        expect((await as(adminToken).post('/admin/delivery-agents', newAgentBody(bad))).status).toBe(400);
      }
      const customerToken = await signTestAccessToken({
        sub: (await fx.insertCustomer()).userId,
        role: 'customer',
      });
      expect((await as(customerToken).post('/admin/delivery-agents', newAgentBody())).status).toBe(403);
      expect((await as(undefined).get('/admin/delivery-agents')).status).toBe(401);
    });

    it('lists with filters, shows one agent, and updates it partially', async () => {
      const marker = `Zed ${randomUUID().slice(0, 8)}`;
      const created = successBody<AdminAgentDto>(
        await as(adminToken).post('/admin/delivery-agents', newAgentBody({ fullName: marker })),
      ).data;
      const found = successBody<AdminAgentDto[]>(
        await as(adminToken).get(
          `/admin/delivery-agents?fullName[like]=${encodeURIComponent(marker)}&status[eq]=active&onShift[eq]=false`,
        ),
      ).data;
      expect(found.map((a) => a.id)).toEqual([created.id]);
      expect(
        successBody<AdminAgentDto>(await as(adminToken).get(`/admin/delivery-agents/${created.id}`)).data.id,
      ).toBe(created.id);
      expect((await as(adminToken).get(`/admin/delivery-agents/${UNKNOWN_V7_ID}`)).status).toBe(404);
      expect((await as(adminToken).get('/admin/delivery-agents?onShift[eq]=maybe')).status).toBe(400);

      const updated = await as(adminToken).patch(`/admin/delivery-agents/${created.id}`, {
        phone: '+201551234567',
      });
      expect(successBody<AdminAgentDto>(updated).data).toMatchObject({
        phone: '+201551234567',
        fullName: marker,
      });
      expect((await as(adminToken).patch(`/admin/delivery-agents/${created.id}`, {})).status).toBe(400);
      const badGovernorate = await as(adminToken).patch(`/admin/delivery-agents/${created.id}`, {
        homeGovernorateId: UNKNOWN_V7_ID,
      });
      expect([badGovernorate.status, errorBody(badGovernorate).error.code]).toEqual([
        422,
        'GOVERNORATE_NOT_FOUND',
      ]);
    });

    it('deactivation needs no active shipments, suspends an active login, and activation restores it', async () => {
      const { agentId, userId } = await activeAgent();
      const { shipmentId } = await fx.insertShipmentChain();
      await knex()('shipments')
        .where({ id: shipmentId })
        .update({ status: 'assigned', agent_id: agentId, assigned_at: new Date() });
      const busy = await as(adminToken).post(`/admin/delivery-agents/${agentId}/deactivate`);
      expect([busy.status, errorBody(busy).error.code]).toEqual([409, 'AGENT_HAS_ACTIVE_SHIPMENTS']);

      await knex()('shipments').where({ id: shipmentId }).update({ status: 'cancelled' });
      await knex()('delivery_agents').where({ id: agentId }).update({ on_shift: true });
      const off = successBody<AdminAgentDto>(
        await as(adminToken).post(`/admin/delivery-agents/${agentId}/deactivate`),
      ).data;
      expect(off).toMatchObject({ status: 'inactive', onShift: false, userStatus: 'suspended' });
      expect(await userStatus(userId)).toBe('suspended');
      const twice = await as(adminToken).post(`/admin/delivery-agents/${agentId}/deactivate`);
      expect([twice.status, errorBody(twice).error.code]).toEqual([409, 'AGENT_INVALID_STATUS_TRANSITION']);

      const on = successBody<AdminAgentDto>(
        await as(adminToken).post(`/admin/delivery-agents/${agentId}/activate`),
      ).data;
      expect(on).toMatchObject({ status: 'active', onShift: false, userStatus: 'active' });
      expect((await as(adminToken).post(`/admin/delivery-agents/${agentId}/activate`)).status).toBe(409);
    });

    it('an agent who never accepted the invite is deactivated without touching the login (DE-5)', async () => {
      const created = successBody<AdminAgentDto>(
        await as(adminToken).post('/admin/delivery-agents', newAgentBody()),
      ).data;
      const off = successBody<AdminAgentDto>(
        await as(adminToken).post(`/admin/delivery-agents/${created.id}/deactivate`),
      ).data;
      expect(off).toMatchObject({ status: 'inactive', userStatus: 'invited' });
      const on = successBody<AdminAgentDto>(
        await as(adminToken).post(`/admin/delivery-agents/${created.id}/activate`),
      ).data;
      expect(on).toMatchObject({ status: 'active', userStatus: 'invited' });
    });
  });

  describe('agent', () => {
    it('reads its profile and goes on and off shift', async () => {
      const { token } = await activeAgent();
      expect(successBody<AgentProfileDto>(await as(token).get('/agent/profile')).data).toMatchObject({
        status: 'active',
        onShift: false,
        activeShipmentCount: 0,
      });
      expect(
        successBody<AgentProfileDto>(await as(token).patch('/agent/availability', { onShift: true })).data
          .onShift,
      ).toBe(true);
      expect(
        successBody<AgentProfileDto>(await as(token).patch('/agent/availability', { onShift: false })).data
          .onShift,
      ).toBe(false);
      for (const bad of [{}, { onShift: 'yes' }, { onShift: true, extra: 1 }]) {
        expect((await as(token).patch('/agent/availability', bad)).status).toBe(400);
      }
    });

    it('an inactive agent still sees its profile but can do nothing else (403 AGENT_INACTIVE)', async () => {
      const { agentId, token } = await activeAgent();
      await knex()('delivery_agents').where({ id: agentId }).update({ status: 'inactive', on_shift: false });
      expect(successBody<AgentProfileDto>(await as(token).get('/agent/profile')).data.status).toBe(
        'inactive',
      );
      const res = await as(token).patch('/agent/availability', { onShift: true });
      expect([res.status, errorBody(res).error.code]).toEqual([403, 'AGENT_INACTIVE']);
    });

    it('other roles cannot use the agent routes', async () => {
      expect((await as(adminToken).get('/agent/profile')).status).toBe(403);
      expect((await as(undefined).get('/agent/profile')).status).toBe(401);
    });
  });

  it('public API for finance: agent by user, summaries (DE-11)', async () => {
    const directory = t.container.resolve<IDeliveryAgentDirectory>(TOKENS.DeliveryAgentDirectory);
    const { agentId, userId } = await activeAgent();
    expect(await directory.getAgentByUserId(userId)).toEqual({ agentId, status: 'active' });
    expect(await directory.getAgentByUserId(randomUUID())).toBeNull();
    expect(await directory.getAgentSummaries([agentId, randomUUID()])).toEqual([
      { agentId, fullName: 'Karim Hassan', phone: '+201101234567' },
    ]);
  });
});
