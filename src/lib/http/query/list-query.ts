import { type ErrorDetail } from '../../error/app-error';
import { invalidQuery } from '../../error/common-errors';
import { type CursorPayload, decodeCursor } from '../pagination/cursor';
import { MONEY_PATTERN } from '../validation/validators';

/**
 * The list query language (CLAUDE.md §8):
 *   ?limit=20&cursor=<opaque>&sort=-createdAt&createdAt[gte]=2025-01-15&status[in]=active,pending
 * Every list endpoint declares a whitelist; anything else is a 400 INVALID_QUERY.
 */

export const FilterOp = {
  EQ: 'eq',
  NE: 'ne',
  GT: 'gt',
  GTE: 'gte',
  LT: 'lt',
  LTE: 'lte',
  IN: 'in',
  LIKE: 'like',
} as const;
export type FilterOp = (typeof FilterOp)[keyof typeof FilterOp];

export const FieldType = {
  UUID: 'uuid',
  DATE: 'date',
  NUMBER: 'number',
  MONEY: 'money',
  BOOLEAN: 'boolean',
  ENUM: 'enum',
  TEXT: 'text',
} as const;
export type FieldType = (typeof FieldType)[keyof typeof FieldType];

export interface FieldSpec {
  /** DB column, from the whitelist only: client field names never reach SQL. */
  column: string;
  type: FieldType;
  ops: readonly FilterOp[];
  sortable?: boolean;
  enumValues?: readonly string[];
}

export interface ListSpec {
  fields: Readonly<Record<string, FieldSpec>>;
  /** e.g. `-createdAt`. Must name a sortable field. */
  defaultSort: string;
  /** Extra query params owned by the endpoint (e.g. `q`), passed through untouched. */
  extraParams?: readonly string[];
}

export type FilterValue = string | number | boolean | Date;

export interface ParsedFilter {
  field: string;
  column: string;
  op: FilterOp;
  value: FilterValue | FilterValue[];
}

export interface ParsedSort {
  /** Normalised sort key, e.g. `-createdAt` (also stored in the cursor). */
  key: string;
  field: string;
  column: string;
  type: FieldType;
  direction: 'asc' | 'desc';
}

export interface ParsedListQuery {
  filters: ParsedFilter[];
  sort: ParsedSort;
  limit: number;
  cursor: CursorPayload | null;
  extra: Record<string, string>;
}

export interface ListLimits {
  defaultLimit: number;
  maxLimit: number;
}

const RESERVED_PARAMS = new Set(['limit', 'cursor', 'sort']);
const PARAM_PATTERN = /^([A-Za-z][A-Za-z0-9.]*)(?:\[([a-z]+)\])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const NUMBER_PATTERN = /^-?\d{1,15}(\.\d{1,6})?$/;
const MAX_IN_VALUES = 50;
const MAX_TEXT_LENGTH = 100;
const MAX_VALUE_LENGTH = 2_000;

function detail(field: string, constraint: string, message: string): ErrorDetail {
  return { field, constraint, message };
}

function coerceValue(
  raw: string,
  spec: FieldSpec,
  field: string,
  problems: ErrorDetail[],
): FilterValue | undefined {
  switch (spec.type) {
    case FieldType.UUID:
      if (UUID_PATTERN.test(raw)) return raw.toLowerCase();
      break;
    case FieldType.DATE: {
      const date = new Date(raw);
      if (DATE_PATTERN.test(raw) && !Number.isNaN(date.getTime())) return date;
      break;
    }
    case FieldType.NUMBER:
      if (NUMBER_PATTERN.test(raw)) return Number(raw);
      break;
    case FieldType.MONEY:
      // Kept as a string: money never becomes a JS number (CLAUDE.md §6.2).
      if (MONEY_PATTERN.test(raw)) return raw;
      break;
    case FieldType.BOOLEAN:
      if (raw === 'true' || raw === 'false') return raw === 'true';
      break;
    case FieldType.ENUM:
      if (spec.enumValues?.includes(raw)) return raw;
      break;
    case FieldType.TEXT:
      if (raw.length >= 1 && raw.length <= MAX_TEXT_LENGTH) return raw;
      break;
  }
  problems.push(detail(field, `invalid_${spec.type}`, `${field} must be a valid ${spec.type}`));
  return undefined;
}

function parseLimit(raw: unknown, limits: ListLimits, problems: ErrorDetail[]): number {
  if (raw === undefined) return limits.defaultLimit;
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) {
    problems.push(detail('limit', 'integer', 'limit must be a positive integer'));
    return limits.defaultLimit;
  }
  const limit = Number(raw);
  if (limit < 1 || limit > limits.maxLimit) {
    problems.push(detail('limit', 'range', `limit must be between 1 and ${limits.maxLimit}`));
    return limits.defaultLimit;
  }
  return limit;
}

function parseSort(raw: unknown, spec: ListSpec, problems: ErrorDetail[]): ParsedSort {
  const key = raw === undefined ? spec.defaultSort : raw;
  const fallback = (): ParsedSort => parseSort(undefined, spec, []);
  if (typeof key !== 'string') {
    problems.push(detail('sort', 'single', 'sort must be given once'));
    return fallback();
  }
  const direction = key.startsWith('-') ? 'desc' : 'asc';
  const field = key.replace(/^-/, '');
  const fieldSpec = spec.fields[field];
  if (!fieldSpec?.sortable) {
    problems.push(detail('sort', 'sortable', `cannot sort by "${field}"`));
    if (raw === undefined) throw new Error(`ListSpec defaultSort "${spec.defaultSort}" is not sortable`);
    return fallback();
  }
  return { key, field, column: fieldSpec.column, type: fieldSpec.type, direction };
}

/**
 * Parses Express's (simple-parser) query object. Keys arrive literally as `createdAt[gte]`.
 * Collects every problem and throws one INVALID_QUERY with all of them.
 */
export function parseListQuery(
  query: Readonly<Record<string, unknown>>,
  spec: ListSpec,
  limits: ListLimits,
): ParsedListQuery {
  const problems: ErrorDetail[] = [];
  const filters: ParsedFilter[] = [];
  const extra: Record<string, string> = {};
  const extraParams = new Set(spec.extraParams ?? []);

  const limit = parseLimit(query.limit, limits, problems);
  const sort = parseSort(query.sort, spec, problems);

  for (const [param, rawValue] of Object.entries(query)) {
    if (RESERVED_PARAMS.has(param)) continue;
    if (typeof rawValue !== 'string' || rawValue.length > MAX_VALUE_LENGTH) {
      problems.push(detail(param, 'single', `${param} must be given once, as text`));
      continue;
    }
    if (extraParams.has(param)) {
      extra[param] = rawValue;
      continue;
    }
    const match = PARAM_PATTERN.exec(param);
    const field = match?.[1];
    const op = (match?.[2] ?? FilterOp.EQ) as FilterOp;
    const fieldSpec = field ? spec.fields[field] : undefined;
    if (!field || !fieldSpec) {
      problems.push(detail(param, 'unknown', `unknown query parameter "${param}"`));
      continue;
    }
    if (!fieldSpec.ops.includes(op)) {
      problems.push(detail(param, 'operator', `operator "${op}" is not allowed on ${field}`));
      continue;
    }

    if (op === FilterOp.IN) {
      const parts = rawValue.split(',').map((part) => part.trim());
      if (parts.length === 0 || parts.length > MAX_IN_VALUES || parts.some((part) => part.length === 0)) {
        problems.push(detail(param, 'in', `${param} needs 1..${MAX_IN_VALUES} comma-separated values`));
        continue;
      }
      const values = parts.map((part) => coerceValue(part, fieldSpec, param, problems));
      if (values.every((value) => value !== undefined)) {
        filters.push({ field, column: fieldSpec.column, op, value: values });
      }
      continue;
    }

    const value = coerceValue(rawValue, fieldSpec, param, problems);
    if (value !== undefined) filters.push({ field, column: fieldSpec.column, op, value });
  }

  let cursor: CursorPayload | null = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string') {
      problems.push(detail('cursor', 'single', 'cursor must be given once'));
    } else if (problems.length === 0) {
      cursor = decodeCursor(query.cursor, sort.key);
    }
  }

  if (problems.length > 0) throw invalidQuery(problems);
  return { filters, sort, limit, cursor, extra };
}
