import { type Request } from 'express';

/**
 * One cookie of the request, without a cookie-parsing middleware (only the auth endpoints read one).
 * The first occurrence wins; a value that isn't valid percent-encoding is returned as sent.
 */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1 || pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}
