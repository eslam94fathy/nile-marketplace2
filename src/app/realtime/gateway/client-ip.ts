import { type IncomingHttpHeaders } from 'node:http';

/**
 * The client address behind `trustedHops` proxies, as Express computes it for `trust proxy = N`
 * (the api's rule, CLAUDE.md §7): the socket address and the X-Forwarded-For entries, counted from
 * the right, skipping one per trusted hop. Without proxies it is the socket address.
 */
export function clientIp(headers: IncomingHttpHeaders, remoteAddress: string, trustedHops: number): string {
  const header = headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const chain = [...forwarded, remoteAddress];
  return chain[Math.max(0, chain.length - 1 - trustedHops)] ?? remoteAddress;
}
