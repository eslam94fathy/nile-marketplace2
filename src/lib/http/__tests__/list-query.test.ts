import { describe, expect, it } from 'vitest';
import { AppError } from '../../error';
import { decodeCursor, encodeCursor, FieldType, FilterOp, type ListSpec, parseListQuery, toPage } from '..';

const spec: ListSpec = {
  fields: {
    status: {
      column: 'status',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: ['active', 'draft'],
    },
    createdAt: {
      column: 'created_at',
      type: FieldType.DATE,
      ops: [FilterOp.GTE, FilterOp.LTE],
      sortable: true,
    },
    minPrice: {
      column: 'min_price',
      type: FieldType.MONEY,
      ops: [FilterOp.GTE, FilterOp.LTE],
      sortable: true,
    },
    sellerId: { column: 'seller_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    name: { column: 'name', type: FieldType.TEXT, ops: [FilterOp.LIKE] },
    inStock: { column: 'in_stock', type: FieldType.BOOLEAN, ops: [FilterOp.EQ] },
  },
  defaultSort: '-createdAt',
  extraParams: ['q'],
};
const limits = { defaultLimit: 20, maxLimit: 100 };
const ID = '01920d3e-7a1c-7c2b-9a4e-3f0c2d1b6a55';

function problemsOf(query: Record<string, unknown>) {
  try {
    parseListQuery(query, spec, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toMatch(/INVALID_QUERY|INVALID_CURSOR/);
    return (error as AppError).details ?? [];
  }
  throw new Error('expected parseListQuery to throw');
}

describe('lib/http parseListQuery', () => {
  it('applies defaults', () => {
    const parsed = parseListQuery({}, spec, limits);
    expect(parsed.limit).toBe(20);
    expect(parsed.sort).toEqual({
      key: '-createdAt',
      field: 'createdAt',
      column: 'created_at',
      type: 'date',
      direction: 'desc',
    });
    expect(parsed.filters).toEqual([]);
    expect(parsed.cursor).toBeNull();
  });

  it('parses filters, operators, types and extra params', () => {
    const parsed = parseListQuery(
      {
        'status[in]': 'active,draft',
        'createdAt[gte]': '2025-01-15',
        'minPrice[lte]': '100.50',
        sellerId: ID.toUpperCase(),
        'name[like]': '50%_off',
        'inStock[eq]': 'true',
        q: 'phone',
        sort: 'minPrice',
        limit: '5',
      },
      spec,
      limits,
    );
    expect(parsed.limit).toBe(5);
    expect(parsed.sort.direction).toBe('asc');
    expect(parsed.extra).toEqual({ q: 'phone' });
    expect(parsed.filters).toEqual(
      expect.arrayContaining([
        { field: 'status', column: 'status', op: 'in', value: ['active', 'draft'] },
        { field: 'createdAt', column: 'created_at', op: 'gte', value: new Date('2025-01-15') },
        { field: 'minPrice', column: 'min_price', op: 'lte', value: '100.50' },
        { field: 'sellerId', column: 'seller_id', op: 'eq', value: ID },
        { field: 'name', column: 'name', op: 'like', value: '50%_off' },
        { field: 'inStock', column: 'in_stock', op: 'eq', value: true },
      ]),
    );
  });

  it('rejects unknown fields, operators, bad values and bad limits, all at once', () => {
    const problems = problemsOf({
      'password[eq]': 'x',
      'status[gt]': 'active',
      'status[eq]': 'deleted',
      'createdAt[gte]': 'yesterday',
      'minPrice[gte]': '1.234',
      limit: '1000',
    });
    expect(problems.map((p) => p.field).sort()).toEqual(
      ['createdAt[gte]', 'limit', 'minPrice[gte]', 'password[eq]', 'status[eq]', 'status[gt]'].sort(),
    );
  });

  it('never coerces limit to NaN', () => {
    expect(problemsOf({ limit: 'abc' })[0]).toMatchObject({ field: 'limit' });
    expect(problemsOf({ limit: '0' })[0]).toMatchObject({ field: 'limit' });
    expect(problemsOf({ limit: '2.5' })[0]).toMatchObject({ field: 'limit' });
  });

  it('rejects repeated params and unsortable sorts', () => {
    expect(problemsOf({ status: ['active', 'draft'] })[0]).toMatchObject({
      field: 'status',
      constraint: 'single',
    });
    expect(problemsOf({ sort: '-name' })[0]).toMatchObject({ field: 'sort' });
  });

  it('decodes a cursor only for the sort it was made for', () => {
    const cursor = encodeCursor({ sort: '-createdAt', value: '2026-01-01T00:00:00.000Z', id: ID });
    expect(parseListQuery({ cursor }, spec, limits).cursor).toEqual({
      sort: '-createdAt',
      value: '2026-01-01T00:00:00.000Z',
      id: ID,
    });
    expect(() => parseListQuery({ cursor, sort: 'minPrice' }, spec, limits)).toThrow(/Cursor is invalid/);
    expect(() => decodeCursor('!!!', '-createdAt')).toThrow(/Cursor is invalid/);
    expect(() =>
      decodeCursor(Buffer.from('{"s":"-createdAt","v":1,"id":"nope"}').toString('base64url'), '-createdAt'),
    ).toThrow();
  });

  it('builds a page with nextCursor from the last returned row', () => {
    const query = parseListQuery({ limit: '2' }, spec, limits);
    const rows = [
      { id: '00000000-0000-7000-8000-000000000003', createdAt: new Date('2026-01-03T00:00:00Z') },
      { id: '00000000-0000-7000-8000-000000000002', createdAt: new Date('2026-01-02T00:00:00Z') },
      { id: '00000000-0000-7000-8000-000000000001', createdAt: new Date('2026-01-01T00:00:00Z') },
    ];
    const page = toPage(rows, query, (row) => row.createdAt);
    expect(page.items).toHaveLength(2);
    expect(page.meta.hasMore).toBe(true);
    expect(page.meta.limit).toBe(2);
    expect(decodeCursor(page.meta.nextCursor ?? '', '-createdAt')).toEqual({
      sort: '-createdAt',
      value: '2026-01-02T00:00:00.000Z',
      id: '00000000-0000-7000-8000-000000000002',
    });
    expect(toPage(rows.slice(0, 2), query, (row) => row.createdAt).meta).toEqual({
      nextCursor: null,
      hasMore: false,
      limit: 2,
    });
  });
});
