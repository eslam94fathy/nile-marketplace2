import { randomBytes, randomInt } from 'node:crypto';

/** Opaque random token, base64url-encoded (32 bytes → 43 chars). */
export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16) {
    throw new RangeError('randomToken needs at least 16 bytes');
  }
  return randomBytes(bytes).toString('base64url');
}

/** Numeric one-time code with leading zeros kept, e.g. "004213". */
export function randomNumericCode(digits: number): string {
  if (!Number.isInteger(digits) || digits < 4 || digits > 10) {
    throw new RangeError('randomNumericCode supports 4..10 digits');
  }
  return randomInt(0, 10 ** digits)
    .toString()
    .padStart(digits, '0');
}
