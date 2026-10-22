/**
 * The push services the worker may send to (spec 13 UC-NO-4: the endpoint is a URL a client chose, so
 * an unchecked one would let it make the worker call anything, SSRF). An entry is an exact host
 * (`fcm.googleapis.com`) or `*.` plus a domain for its subdomains only (`*.notify.windows.com`).
 */
export function isAllowedPushEndpoint(endpoint: string, allowlist: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // https on its default port, no credentials: anything else is not a push service.
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '')
    return false;
  const host = url.hostname.toLowerCase();
  return allowlist.some((entry) => {
    const pattern = entry.toLowerCase();
    return pattern.startsWith('*.')
      ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
      : host === pattern;
  });
}
