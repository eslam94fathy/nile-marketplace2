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

function applyFilter(qb: Knex.QueryBuilder, filter: ParsedFilter & { column: string }): void {
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

export interface ApplyListQueryOptions {
  /**
   * Orders by this expression instead of the sort column. Required when the active sort is a custom
   * field (no column), e.g. search relevance. It must be deterministic (the keyset compares the
   * cursor value against it) and NOT NULL within the filtered set.
   */
  sortExpression?: Knex.Raw;
}

/**
 * Applies the column filters, keyset position, ordering and `limit + 1` (to detect `hasMore`).
 * Custom and prefix filters (`column: null`) are skipped: the caller applies them.
 * The sort column must be NOT NULL within the filtered set; ties break on `idColumn`.
 */
export function applyListQuery(
  qb: Knex.QueryBuilder,
  query: ParsedListQuery,
  idColumn: string,
  options: ApplyListQueryOptions = {},
): Knex.QueryBuilder {
  for (const filter of query.filters) {
    if (filter.column !== null) applyFilter(qb, { ...filter, column: filter.column });
  }

  const { sort, cursor } = query;
  if (options.sortExpression) return applyExpressionSort(qb, query, idColumn, options.sortExpression);
  if (sort.column === null) {
    throw new Error(`Sort "${sort.field}" has no column: pass a sortExpression to applyListQuery`);
  }
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

function applyExpressionSort(
  qb: Knex.QueryBuilder,
  query: ParsedListQuery,
  idColumn: string,
  expression: Knex.Raw,
): Knex.QueryBuilder {
  const { sort, cursor } = query;
  // `direction` comes from the parser ('asc' | 'desc'), never from raw client text.
  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC';
  if (cursor) {
    const comparator = sort.direction === 'desc' ? '<' : '>';
    qb.whereRaw(`(?, ??) ${comparator} (?, ?)`, [expression, idColumn, cursor.value, cursor.id]);
  }
  return qb.orderByRaw(`? ${direction}, ?? ${direction}`, [expression, idColumn]).limit(query.limit + 1);
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
