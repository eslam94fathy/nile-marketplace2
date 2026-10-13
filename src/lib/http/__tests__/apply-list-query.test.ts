import knexFactory from 'knex';
import { describe, expect, it } from 'vitest';
import { applyListQuery, encodeCursor, FieldType, FilterOp, type ListSpec, parseListQuery } from '..';

// SQL generation only: no connection is ever opened.
const knex = knexFactory({ client: 'pg' });
const ID = '01920d3e-7a1c-7c2b-9a4e-3f0c2d1b6a55';
const limits = { defaultLimit: 20, maxLimit: 100 };

const spec: ListSpec = {
  fields: {
    categoryId: { type: FieldType.UUID, ops: [FilterOp.EQ] },
    inStock: { column: 'p.in_stock', type: FieldType.BOOLEAN, ops: [FilterOp.EQ] },
    publishedAt: { column: 'p.published_at', type: FieldType.DATE, ops: [], sortable: true },
    relevance: { type: FieldType.NUMBER, ops: [], sortable: true },
  },
  prefixFields: { 'attr.': { type: FieldType.TEXT, ops: [FilterOp.IN], maxKeys: 5 } },
  defaultSort: '-publishedAt',
};

function sql(query: Record<string, unknown>, sortExpression?: ReturnType<typeof knex.raw>) {
  const parsed = parseListQuery(query, spec, limits);
  const qb = knex('products as p').select('p.id');
  return applyListQuery(qb, parsed, 'p.id', sortExpression ? { sortExpression } : {})
    .toSQL()
    .toNative();
}

describe('lib/http applyListQuery', () => {
  it('applies column filters and skips custom and prefix ones', () => {
    const { sql: text, bindings } = sql({ inStock: 'true', categoryId: ID, 'attr.size[in]': 'xl' });
    expect(text).toBe(
      'select "p"."id" from "products" as "p" where "p"."in_stock" = $1 ' +
        'order by "p"."published_at" desc, "p"."id" desc limit $2',
    );
    expect(bindings).toEqual([true, 21]);
  });

  it('orders and pages by a sort expression, with its bindings in place', () => {
    const relevance = knex.raw('round(similarity(p.name, ?)::numeric, 6)', ['phone']);
    const cursor = encodeCursor({ sort: '-relevance', value: '0.512345', id: ID });
    const { sql: text, bindings } = sql({ sort: '-relevance', cursor }, relevance);
    expect(text).toBe(
      'select "p"."id" from "products" as "p" ' +
        'where (round(similarity(p.name, $1)::numeric, 6), "p"."id") < ($2, $3) ' +
        'order by round(similarity(p.name, $4)::numeric, 6) DESC, "p"."id" DESC limit $5',
    );
    expect(bindings).toEqual(['phone', '0.512345', ID, 'phone', 21]);
  });

  it('refuses a column-less sort without an expression', () => {
    const parsed = parseListQuery({ sort: 'relevance' }, spec, limits);
    expect(() => applyListQuery(knex('products as p'), parsed, 'p.id')).toThrow(/sortExpression/);
  });
});
