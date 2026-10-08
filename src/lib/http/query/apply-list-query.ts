import { type Knex } from 'knex';
import { encodeCursor, type CursorValue } from '../pagination/cursor';
import { type PageMeta } from '../response';
import { FieldType, FilterOp, type ParsedFilter, type ParsedListQuery } from './list-query';

const SQL_OPERATOR: Readonly<Record<Exclude<FilterOp, 'in' | 'like'>, string>> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/** Escapes LIKE wildcards so user text is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function applyFilter(qb: Knex.QueryBuilder, filter: ParsedFilter): void {
  // Columns come from the endpoint's whitelist, values are always bound parameters (CLAUDE.md §6.4).
  if (filter.op === FilterOp.IN) {
    qb.whereIn(filter.column, filter.value as readonly Knex.Value[]);
    return;
  }
  if (filter.op === FilterOp.LIKE) {
    qb.whereRaw(`?? ILIKE ? ESCAPE '\\'`, [filter.column, `%${escapeLike(String(filter.value))}%`]);
    return;
  }
  qb.where(filter.column, SQL_OPERATOR[filter.op], filter.value as Knex.Value);
}

/**
 * Applies filters, keyset position, ordering and `limit + 1` (to detect `hasMore`).
 * The sort column must be NOT NULL within the filtered set; ties break on `idColumn`.
 */
export function applyListQuery(
  qb: Knex.QueryBuilder,
  query: ParsedListQuery,
  idColumn: string,
): Knex.QueryBuilder {
  for (const filter of query.filters) applyFilter(qb, filter);

  const { sort, cursor } = query;
  if (cursor) {
    const value: Knex.Value = sort.type === FieldType.DATE ? new Date(String(cursor.value)) : cursor.value;
    const comparator = sort.direction === 'desc' ? '<' : '>';
    qb.whereRaw(`(??, ??) ${comparator} (?, ?)`, [sort.column, idColumn, value, cursor.id]);
  }
  return qb
    .orderBy([
      { column: sort.column, order: sort.direction },
      { column: idColumn, order: sort.direction },
    ])
    .limit(query.limit + 1);
}

/**
 * Trims the extra row and builds `meta` (CLAUDE.md §8).
 * `sortValueOf` returns the item's value for the active sort (Dates become ISO strings in the cursor).
 */
export function toPage<T extends { id: string }>(
  rows: readonly T[],
  query: ParsedListQuery,
  sortValueOf: (row: T) => CursorValue | Date,
): { items: T[]; meta: PageMeta } {
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : [...rows];
  const last = items.at(-1);
  let nextCursor: string | null = null;
  if (hasMore && last) {
    const raw = sortValueOf(last);
    nextCursor = encodeCursor({
      sort: query.sort.key,
      value: raw instanceof Date ? raw.toISOString() : raw,
      id: last.id,
    });
  }
  return { items, meta: { nextCursor, hasMore, limit: query.limit } };
}
