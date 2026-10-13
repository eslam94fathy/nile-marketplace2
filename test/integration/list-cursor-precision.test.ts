import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AdminAgentDto } from '../../src/app/delivery/dto/delivery-agent.dto';
import { deliveryFixtures } from '../helpers/delivery-fixtures';
import { successBody } from '../helpers/http';
import { API } from '../helpers/identity';
import { signTestAccessToken } from '../helpers/jwt';
import { startTestApp, type TestApp } from '../helpers/test-app';

/** Every timestamp a list cursor sorts on (migration 20261012140001, database D-11; finance tables D-12). */
const CURSOR_COLUMNS = [
  ['users', 'created_at'],
  ['sellers', 'created_at'],
  ['products', 'created_at'],
  ['products', 'published_at'],
  ['inventory_movements', 'created_at'],
  ['orders', 'created_at'],
  ['seller_orders', 'created_at'],
  ['payment_refunds', 'created_at'],
  ['delivery_agents', 'created_at'],
  ['shipments', 'created_at'],
  ['finance_accounts', 'updated_at'],
  ['ledger_entries', 'created_at'],
  ['cod_remittances', 'created_at'],
  ['payouts', 'created_at'],
] as const;

/*
 * Regression: the cursor carries a JS Date (milliseconds). With microsecond columns an ascending
 * page repeated its last row and a descending one skipped same-millisecond rows.
 */
describe('list cursors over timestamps', () => {
  let t: TestApp;
  let adminToken: string;
  let ids: string[];

  const knex = () => t.infra.db.knex;

  async function pageThrough(sort: string): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await request(t.app)
        .get(
          `${API}/admin/delivery-agents?fullName[like]=Precision&sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        )
        .set('Authorization', `Bearer ${adminToken}`);
      const page: { data: AdminAgentDto[]; meta?: { nextCursor?: string | null } } =
        successBody<AdminAgentDto[]>(res);
      seen.push(...page.data.map((a) => a.id));
      cursor = page.meta?.nextCursor ?? null;
    } while (cursor);
    return seen;
  }

  beforeAll(async () => {
    t = await startTestApp();
    const fx = deliveryFixtures(knex());
    adminToken = await signTestAccessToken({ sub: await fx.insertUser('admin'), role: 'admin' });
    // Microseconds apart, several within one millisecond.
    const stamps = [
      '2026-01-01T00:00:00.123100Z',
      '2026-01-01T00:00:00.123456Z',
      '2026-01-01T00:00:00.123499Z',
      '2026-01-01T00:00:00.124700Z',
      '2026-01-01T00:00:00.124900Z',
    ];
    ids = [];
    for (const createdAt of stamps) {
      const { agentId } = await fx.insertAgent({ full_name: 'Precision Agent', created_at: createdAt });
      ids.push(agentId);
    }
  });
  afterAll(async () => {
    await t.close();
  });

  it('every cursor column stores milliseconds', async () => {
    const rows = await knex()('information_schema.columns')
      .where({ table_schema: 'public' })
      .whereIn(
        ['table_name', 'column_name'],
        CURSOR_COLUMNS.map(([table, column]) => [table, column]),
      )
      .select<{ table_name: string; column_name: string; datetime_precision: number }[]>(
        'table_name',
        'column_name',
        'datetime_precision',
      );
    expect(rows).toHaveLength(CURSOR_COLUMNS.length);
    expect(rows.filter((r) => r.datetime_precision !== 3)).toEqual([]);
  });

  it('ascending and descending pages return every row exactly once, in order', async () => {
    const ordered = await knex()('delivery_agents')
      .whereIn('id', ids)
      .orderBy([{ column: 'created_at' }, { column: 'id' }])
      .pluck<string[]>('id');
    expect(await pageThrough('createdAt')).toEqual(ordered);
    expect(await pageThrough('-createdAt')).toEqual([...ordered].reverse());
  });
});
