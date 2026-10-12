'use strict';
// Usage: npm run dev:kashier-webhook -- <orderId> [paid|failed] [amount]
// Local development only (spec 10 PA-5): sends the local api a Kashier "pay" webhook for the order's
// payment, signed with KASHIER_API_KEY exactly as Kashier signs it, so the real verification path runs.
// "paid" (default) succeeds with the payment amount unless [amount] says otherwise (e.g. to try an
// amount mismatch); "failed" is a declined attempt (recorded only, S-4). Needs `npm run build` (it signs
// with the compiled pkg/payments) and the api on localhost:PORT.
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const knex = require('knex');

const [orderId, outcome = 'paid', amountArg] = process.argv.slice(2);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE_KEYS = ['amount', 'currency', 'merchantOrderId', 'status', 'transactionId'];

function fail(message) {
  console.error(`dev-kashier-webhook: ${message}`);
  process.exit(1);
}

async function main() {
  if (process.env.NODE_ENV !== 'development') fail('local development only (NODE_ENV=development)');
  if (!orderId || !UUID.test(orderId) || !['paid', 'failed'].includes(outcome)) {
    fail('usage: npm run dev:kashier-webhook -- <orderId> [paid|failed] [amount]');
  }
  let signKashierWebhook;
  try {
    ({ signKashierWebhook } = require(path.join(__dirname, '..', 'dist', 'pkg', 'payments')));
  } catch {
    fail('dist/ not found: run `npm run build` first');
  }

  const db = knex({ client: 'pg', connection: process.env.DATABASE_URL });
  try {
    const payment = await db('payments')
      .where({ order_id: orderId })
      .first('id', 'method', 'status', 'amount');
    if (!payment) fail(`order ${orderId} has no payment`);
    if (payment.method !== 'kashier') fail(`order ${orderId} is paid by ${payment.method}, not kashier`);

    const data = {
      merchantOrderId: payment.id,
      transactionId: `DEV-${randomUUID()}`,
      status: outcome === 'paid' ? 'SUCCESS' : 'FAILED',
      amount: Number(amountArg ?? payment.amount),
      currency: 'EGP',
      method: 'card',
      signatureKeys: SIGNATURE_KEYS,
    };
    const res = await fetch(`http://localhost:${process.env.PORT}/api/v1/webhooks/kashier`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-kashier-signature': signKashierWebhook(data, SIGNATURE_KEYS, process.env.KASHIER_API_KEY),
      },
      body: JSON.stringify({ event: 'pay', data }),
    });
    console.log(
      `sent ${data.status} for payment ${payment.id} (was ${payment.status}, amount ${data.amount}): HTTP ${res.status}`,
    );
    if (!res.ok) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

main().catch((error) => fail(error.message));
