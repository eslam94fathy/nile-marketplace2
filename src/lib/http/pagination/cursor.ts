import { invalidCursor } from '../../error/common-errors';

/**
 * Opaque keyset cursor: base64url of `{ s, v, id }` (CLAUDE.md §8).
 * `s` = the sort it was made for, so a cursor can't be replayed under another sort.
 */
export type CursorValue = string | number;

export interface CursorPayload {
  sort: string;
  value: CursorValue;
  id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CURSOR_LENGTH = 512;

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify({ s: payload.sort, v: payload.value, id: payload.id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(raw: string, expectedSort: string): CursorPayload {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
  const { s, v, id } = parsed as Record<string, unknown>;
  const validValue = typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
  if (s !== expectedSort || !validValue || typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw invalidCursor();
  }
  return { sort: s, value: v, id };
}
