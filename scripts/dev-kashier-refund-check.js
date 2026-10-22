'use strict';
// Usage (Kashier TEST environment only, spec 10 PA-27, plan R2-P6 step 7):
//   npm run dev:kashier-refund-check -- session <amount>
//       Opens a test payment session; pay it in the browser with a Kashier test card.
//   npm run dev:kashier-refund-check -- status <sessionId>
//       Reads the session back (the unauthenticated read the expiry job uses, PA-13).
//   npm run dev:kashier-refund-check -- refund <orderRef> <amount> [targetTransactionId] [--base <url>]
//       PUT <base>/v3/orders/<orderRef> { apiOperation: "REFUND", transaction: { amount } }.
//   npm run dev:kashier-refund-check -- get </path> [--base <url>]
//       Any authenticated GET, to look for a read of an order's refunds.
//   npm run dev:kashier-refund-check -- order <orderRef> [--base <url>]
//       GET <base>/v3/orders/<orderRef>: whether an order (and its refunds) can be read back.
// <base> defaults to KASHIER_BASE_URL. Every response is printed with keys, tokens, signatures and card
// data redacted; nothing is stored. It refuses to run unless KASHIER_MODE=test on a test-* host.
const { randomUUID } = require('node:crypto');

const args = process.argv.slice(2);
const baseFlag = args.indexOf('--base');
const base = (baseFlag >= 0 ? args.splice(baseFlag, 2)[1] : process.env.KASHIER_BASE_URL) ?? '';
const [command, ...rest] = args;
const PLACEHOLDER_URL = 'https://example.com/nile-refund-check';
const SECRET_FIELD = /key|secret|token|signature|card|pan|cvv|hash|authorization/i;

function fail(message) {
  console.error(`dev-kashier-refund-check: ${message}`);
  process.exit(1);
}

/** Never print a credential or card data, wherever Kashier puts it. */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_FIELD.test(k) ? '[REDACTED]' : redact(v)]),
    );
  }
  if (
    typeof value === 'string' &&
    process.env.KASHIER_SECRET_KEY &&
    value.includes(process.env.KASHIER_SECRET_KEY)
  ) {
    return '[REDACTED]';
  }
  return value;
}

async function call(method, url, { auth, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    headers['api-key'] = process.env.KASHIER_API_KEY;
    headers.Authorization = process.env.KASHIER_SECRET_KEY;
  }
  const started = Date.now();
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.KASHIER_HTTP_TIMEOUT_MS ?? 15000)),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { nonJsonBody: text.replace(/\s+/g, ' ').slice(0, 300) };
  }
  console.log(
    `${method} ${url.replace(/\/v3\/.*/, '/v3/…')} → HTTP ${res.status} in ${Date.now() - started} ms`,
  );
  console.log(JSON.stringify(redact(json), null, 2));
  return json;
}

async function main() {
  if (process.env.KASHIER_MODE !== 'test') fail('KASHIER_MODE must be test');
  if (!/^https:\/\/test-[a-z0-9-]+\.kashier\.io$/.test(base))
    fail(`base must be a https://test-*.kashier.io host, got "${base}"`);
  for (const key of ['KASHIER_API_KEY', 'KASHIER_SECRET_KEY', 'KASHIER_MERCHANT_ID']) {
    if (!process.env[key]) fail(`${key} is not set`);
  }

  if (command === 'session') {
    const [amount] = rest;
    if (!/^\d+\.\d{2}$/.test(amount ?? '')) fail('usage: session <amount like 150.00>');
    const order = randomUUID();
    const response = await call('POST', `${base}/v3/payment/sessions`, {
      auth: true,
      body: {
        paymentType: 'credit',
        type: 'one-time',
        allowedMethods: 'card,wallet',
        enable3DS: true,
        failureRedirect: false,
        interactionSource: 'ECOMMERCE',
        merchantId: process.env.KASHIER_MERCHANT_ID,
        amount,
        currency: 'EGP',
        order,
        expireAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        // Placeholders are fine here: the check reads results back instead of waiting for webhooks.
        serverWebhook: process.env.KASHIER_WEBHOOK_URL || PLACEHOLDER_URL,
        merchantRedirect: process.env.KASHIER_REDIRECT_URL || PLACEHOLDER_URL,
        description: 'R2-P6 refund check',
        customer: { reference: 'refund-check' },
      },
    });
    console.log(`\nour order ref (merchantOrderId): ${order}`);
    console.log(`session id: ${response._id ?? '?'}`);
    console.log(`pay here with a test card: ${response.sessionUrl ?? '?'}`);
    return;
  }
  if (command === 'status') {
    const [sessionId] = rest;
    if (!sessionId) fail('usage: status <sessionId>');
    await call('GET', `${base}/v3/payment/sessions/${encodeURIComponent(sessionId)}`, { auth: false });
    return;
  }
  if (command === 'refund') {
    const [orderRef, amount, targetTransactionId] = rest;
    if (!orderRef || !/^\d+\.\d{2}$/.test(amount ?? ''))
      fail('usage: refund <orderRef> <amount> [targetTransactionId]');
    await call('PUT', `${base}/v3/orders/${encodeURIComponent(orderRef)}`, {
      auth: true,
      body: {
        apiOperation: 'REFUND',
        reason: 'R2-P6 refund check',
        transaction: { amount: Number(amount), ...(targetTransactionId ? { targetTransactionId } : {}) },
      },
    });
    return;
  }
  if (command === 'order') {
    const [orderRef] = rest;
    if (!orderRef) fail('usage: order <orderRef>');
    await call('GET', `${base}/v3/orders/${encodeURIComponent(orderRef)}`, { auth: true });
    return;
  }
  if (command === 'get') {
    const [readPath] = rest;
    if (!readPath?.startsWith('/')) fail('usage: get </path> [--base <url>]');
    await call('GET', `${base}${readPath}`, { auth: true });
    return;
  }
  fail('commands: session | status | refund | order | get (see the header of this file)');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
