import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FakePaymentGateway,
  KashierPaymentGateway,
  PaymentGatewayError,
  readKashierWebhook,
  signKashierWebhook,
  toProviderStatus,
} from '..';
import { kashierSignedString } from '../kashier-webhook';

const API_KEY = 'test-api-key';
const SECRET_KEY = 'secret$with-dollar';

/** A Kashier-shaped webhook body and its signature. */
function webhook(dataOverrides: Record<string, unknown> = {}, key = API_KEY) {
  const data: Record<string, unknown> = {
    merchantOrderId: '01a12f8e-0000-7000-8000-000000000001',
    kashierOrderId: 'KO-1',
    transactionId: 'TX-77 a/b',
    status: 'SUCCESS',
    amount: 16.3,
    currency: 'EGP',
    method: 'card',
    card: { last4: '4242', cardHolderName: 'Mona' },
    hash: 'internal',
    signatureKeys: ['transactionId', 'amount', 'currency', 'merchantOrderId', 'status'],
    ...dataOverrides,
  };
  const keys = data.signatureKeys as string[];
  return {
    body: Buffer.from(JSON.stringify({ event: 'pay', data })),
    signature: signKashierWebhook(data, keys, key),
  };
}

describe('Kashier webhook signature (spec 10 PA-1)', () => {
  it('signs the sorted signatureKeys as name=encodeURIComponent(value) pairs, HMAC-SHA256 hex', () => {
    const data = { transactionId: 'TX-77 a/b', amount: 16.3, status: 'SUCCESS', currency: 'EGP', extra: 'x' };
    const keys = ['transactionId', 'amount', 'status', 'currency', 'missing'];
    const expected = 'amount=16.3&currency=EGP&missing=&status=SUCCESS&transactionId=TX-77%20a%2Fb';
    expect(kashierSignedString(data, keys)).toBe(expected);
    // Independent of our helper: the HMAC of that exact string.
    expect(signKashierWebhook(data, keys, API_KEY)).toBe(
      createHmac('sha256', API_KEY).update(expected).digest('hex'),
    );
  });

  it('reads a valid webhook: dedupe id, outcome from data.status, 2-decimal amount, nothing secret stored', () => {
    const { body, signature } = webhook();
    const notification = readKashierWebhook(body, signature, API_KEY);
    expect(notification).toMatchObject({
      event: 'pay',
      eventId: 'pay:TX-77 a/b',
      transactionId: 'TX-77 a/b',
      merchantOrderId: '01a12f8e-0000-7000-8000-000000000001',
      succeeded: true,
      amount: '16.30',
      currency: 'EGP',
    });
    const stored = JSON.stringify(notification?.storablePayload);
    expect(stored).not.toMatch(/4242|cardHolderName|"card":|"hash":|internal|signatureKeys/);
    expect(stored).toContain('"method":"card"');
    expect(stored).toContain('KO-1');
  });

  it('a failed payment is a valid webhook that did not succeed', () => {
    const { body, signature } = webhook({ status: 'FAILED' });
    expect(readKashierWebhook(body, signature, API_KEY)?.succeeded).toBe(false);
  });

  it.each([
    ['no signature header', () => ({ body: webhook().body, signature: undefined })],
    ['a signature by another key', () => webhook({}, 'other-key')],
    [
      'a tampered amount',
      () => ({ ...webhook(), body: Buffer.from(webhook().body.toString().replace('16.3', '1630')) }),
    ],
    ['a signature that is not hex', () => ({ body: webhook().body, signature: 'z'.repeat(64) })],
    ['a body that is not JSON', () => ({ body: Buffer.from('not json'), signature: webhook().signature })],
    ['no signatureKeys', () => webhook({ signatureKeys: [] })],
    ['an amount with 3 decimals', () => webhook({ amount: 16.305 })],
    ['no transactionId', () => webhook({ transactionId: undefined })],
  ])('rejects %s', (_name, make) => {
    const { body, signature } = make();
    expect(readKashierWebhook(body, signature, API_KEY)).toBeNull();
  });

  // PA-21: a field we act on that is not signed could have been changed (security review F-1).
  it.each(['merchantOrderId', 'status', 'amount', 'currency', 'transactionId'])(
    'rejects a correctly signed webhook whose signatureKeys leave out %s',
    (field) => {
      const signatureKeys = ['transactionId', 'amount', 'currency', 'merchantOrderId', 'status'].filter(
        (key) => key !== field,
      );
      const { body, signature } = webhook({ signatureKeys });
      expect(readKashierWebhook(body, signature, API_KEY)).toBeNull();
    },
  );
});

describe('toProviderStatus (spec 10 PA-13)', () => {
  it.each([
    ['PAID', 'paid'],
    ['AUTHORIZED', 'paid'],
    ['REFUNDED', 'paid'],
    ['PARTIALLY_REFUNDED', 'paid'],
    ['REFUND_PENDING', 'paid'],
    ['PENDING', 'pending'],
    ['CREATED', 'unpaid'],
    ['OPENED', 'unpaid'],
    ['FAILED', 'unpaid'],
    ['EXPIRED', 'unpaid'],
    ['ABANDONED', 'unpaid'],
    ['REJECTED', 'unpaid'],
    ['VOIDED', 'unpaid'],
    ['SOMETHING_NEW', 'unpaid'],
  ])('%s → %s', (kashier, ours) => {
    expect(toProviderStatus(kashier)).toBe(ours);
  });
});

interface Captured {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
}

describe('KashierPaymentGateway (against a local stand-in)', () => {
  let server: Server;
  let baseUrl: string;
  let captured: Captured | undefined;
  let reply: { status: number; body: string; delayMs?: number };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        captured = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: raw ? (JSON.parse(raw) as unknown) : null,
        };
        setTimeout(() => {
          res.writeHead(reply.status, { 'Content-Type': 'application/json' });
          res.end(reply.body);
        }, reply.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    captured = undefined;
  });

  const gateway = () =>
    new KashierPaymentGateway({
      baseUrl,
      fepBaseUrl: baseUrl,
      merchantId: 'MID-1-2',
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
      webhookUrl: 'https://api.nile.test/api/v1/webhooks/kashier',
      redirectUrl: 'https://app.nile.test/payment-return',
      timeoutMs: 300,
    });
  const input = {
    merchantOrderId: 'payment-1',
    amount: '150.00',
    currency: 'EGP' as const,
    expiresAt: new Date('2026-10-12T10:30:00.000Z'),
    customerReference: 'customer-1',
    description: 'Nile order NM-000000001',
  };
  const failure = async (call: Promise<unknown>) => {
    const error = await call.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentGatewayError);
    return error as PaymentGatewayError;
  };

  it('creates a session with the credentials in headers and our fixed request fields', async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        _id: 'sess-1',
        status: 'CREATED',
        sessionUrl: 'https://payments.kashier.io/session/sess-1?mode=test',
        expireAt: '2026-10-12T10:30:00.000Z',
        apiKey: 'echoed',
      }),
    };
    expect(await gateway().createSession(input)).toEqual({
      sessionId: 'sess-1',
      checkoutUrl: 'https://payments.kashier.io/session/sess-1?mode=test',
      expiresAt: new Date('2026-10-12T10:30:00.000Z'),
    });
    expect(captured?.method).toBe('POST');
    expect(captured?.url).toBe('/v3/payment/sessions');
    expect(captured?.headers['api-key']).toBe(API_KEY);
    expect(captured?.headers.authorization).toBe(SECRET_KEY);
    expect(captured?.body).toEqual({
      merchantId: 'MID-1-2',
      paymentType: 'credit',
      type: 'one-time',
      allowedMethods: 'card,wallet',
      enable3DS: true,
      failureRedirect: false,
      interactionSource: 'ECOMMERCE',
      amount: '150.00',
      currency: 'EGP',
      order: 'payment-1',
      expireAt: '2026-10-12T10:30:00.000Z',
      serverWebhook: 'https://api.nile.test/api/v1/webhooks/kashier',
      merchantRedirect: 'https://app.nile.test/payment-return',
      description: 'Nile order NM-000000001',
      customer: { reference: 'customer-1' },
    });
  });

  it('classifies failures: open session, other refusals, 5xx, timeouts; never echoes the credentials', async () => {
    reply = {
      status: 400,
      body: JSON.stringify({
        error: { cause: 'Session cannot be created' },
        messages: { en: 'Sessions cannot be created, another session is opened or paid' },
        status: 'FAILURE',
      }),
    };
    expect((await failure(gateway().createSession(input))).kind).toBe('session_exists');

    reply = { status: 400, body: JSON.stringify({ message: '"merchantRedirect" is required' }) };
    const rejected = await failure(gateway().createSession(input));
    expect([rejected.kind, rejected.status]).toEqual(['rejected', 400]);
    expect(rejected.message).toContain('merchantRedirect');

    reply = { status: 502, body: '<html>bad gateway</html>' };
    expect((await failure(gateway().createSession(input))).kind).toBe('unavailable');

    reply = { status: 200, body: '{}', delayMs: 1_000 };
    const timeout = await failure(gateway().createSession(input));
    expect(timeout.kind).toBe('unavailable');
    for (const error of [rejected, timeout]) {
      expect(error.message).not.toContain(SECRET_KEY);
      expect(error.message).not.toContain(API_KEY);
    }
  });

  it('reads a session status without credentials (PA-13)', async () => {
    reply = {
      status: 200,
      body: JSON.stringify({ message: 'success', data: { _id: 'sess-1', status: 'PENDING' } }),
    };
    expect(await gateway().getSessionStatus('sess-1')).toEqual({
      status: 'pending',
      providerStatus: 'PENDING',
    });
    expect(captured?.method).toBe('GET');
    expect(captured?.url).toBe('/v3/payment/sessions/sess-1');
    expect(captured?.headers.authorization).toBeUndefined();
    expect(captured?.headers['api-key']).toBeUndefined();

    reply = { status: 404, body: JSON.stringify({ messages: { en: 'Payment session not found' } }) };
    expect((await failure(gateway().getSessionStatus('nope'))).kind).toBe('rejected');
  });

  it('reads a paid session: Kashier answers 400 "already been paid", which means paid (K-9)', async () => {
    reply = {
      status: 400,
      body: JSON.stringify({
        error: { cause: 'Invalid Request' },
        messages: { en: 'The order has already been paid before' },
        status: 'FAILURE',
      }),
    };
    expect(await gateway().getSessionStatus('sess-1')).toEqual({ status: 'paid', providerStatus: 'PAID' });
  });

  /** Kashier's refund answer (K-8), trimmed. */
  const refunded = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      response: {
        apiOperation: 'REFUND',
        result: 'SUCCESS',
        status: 'PARTIALLY_REFUNDED',
        amount: 50,
        totalRefundedAmount: 50,
        transactionId: 'TX-1',
        merchantOrderId: 'payment-1',
        apiKeyId: 'echoed',
        ...overrides,
      },
      messages: { en: 'Approved' },
      status: 'SUCCESS',
      statusCode: 200,
    });

  it('refunds on the FEP host: PUT /v3/orders/<our id>, credentials in headers, the amount as a number (K-8)', async () => {
    reply = { status: 200, body: refunded() };
    expect(
      await gateway().refund({ merchantOrderId: 'payment-1', amount: '50.00', reason: 'Nile refund return' }),
    ).toEqual({
      refundTransactionId: 'TX-1',
      totalRefundedAmount: '50.00',
      providerStatus: 'PARTIALLY_REFUNDED',
    });
    expect(captured?.method).toBe('PUT');
    expect(captured?.url).toBe('/v3/orders/payment-1');
    expect(captured?.headers.authorization).toBe(SECRET_KEY);
    expect(captured?.headers['api-key']).toBe(API_KEY);
    expect(captured?.body).toEqual({
      apiOperation: 'REFUND',
      reason: 'Nile refund return',
      transaction: { amount: 50 },
    });
  });

  it('classifies refund failures by whether the refund may have run (K-12)', async () => {
    const refund = () => gateway().refund({ merchantOrderId: 'payment-1', amount: '50.00', reason: 'r' });
    reply = {
      status: 400,
      body: JSON.stringify({
        messages: { en: 'This order cannot be refunded with provided amount' },
        status: 'FAILURE',
      }),
    };
    const over = await failure(refund());
    expect([over.kind, over.status]).toEqual(['rejected', 400]);
    expect(over.message).toContain('cannot be refunded');

    reply = { status: 429, body: '{}' };
    expect((await failure(refund())).kind).toBe('unavailable');
    reply = { status: 502, body: '<html>bad gateway</html>' };
    expect((await failure(refund())).kind).toBe('unknown_outcome');
    reply = { status: 200, body: refunded(), delayMs: 1_000 };
    expect((await failure(refund())).kind).toBe('unknown_outcome');
    reply = {
      status: 200,
      body: JSON.stringify({ status: 'FAILURE', messages: { en: 'Something went wrong' } }),
    };
    expect((await failure(refund())).kind).toBe('unknown_outcome');

    const nowhere = new KashierPaymentGateway({
      baseUrl,
      fepBaseUrl: await closedPortUrl(),
      merchantId: 'MID-1-2',
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
      webhookUrl: '',
      redirectUrl: '',
      timeoutMs: 300,
    });
    const refused = await failure(
      nowhere.refund({ merchantOrderId: 'payment-1', amount: '1.00', reason: 'r' }),
    );
    expect(refused.kind).toBe('unavailable');
    expect(refused.message).not.toContain(SECRET_KEY);
  });
});

describe('FakePaymentGateway (spec 10 PA-5)', () => {
  it('refunds with a new transaction id and the running total; tests script replays and failures', async () => {
    const fake = new FakePaymentGateway({ apiKey: API_KEY, checkoutBaseUrl: 'http://fake.local' });
    const refund = (amount: string) => fake.refund({ merchantOrderId: 'payment-1', amount, reason: 'r' });
    expect(await refund('50.00')).toMatchObject({
      refundTransactionId: 'FAKE-RF-1',
      totalRefundedAmount: '50.00',
    });
    fake.scriptRefund('replay', 'unknown_outcome');
    expect(await refund('50.00')).toMatchObject({
      refundTransactionId: 'FAKE-RF-1',
      totalRefundedAmount: '50.00',
    });
    expect(((await refund('5.00').catch((e: unknown) => e)) as PaymentGatewayError).kind).toBe(
      'unknown_outcome',
    );
    expect(await refund('5.00')).toMatchObject({
      refundTransactionId: 'FAKE-RF-2',
      totalRefundedAmount: '55.00',
    });
    expect(fake.refundCalls).toHaveLength(4);
  });

  const fake = () =>
    new FakePaymentGateway({ apiKey: API_KEY, checkoutBaseUrl: 'http://localhost:3000/fake-kashier' });
  const input = (merchantOrderId: string, minutes = 15) => ({
    merchantOrderId,
    amount: '10.00',
    currency: 'EGP' as const,
    expiresAt: new Date(Date.now() + minutes * 60_000),
    customerReference: 'c',
    description: 'd',
  });

  it('allows one open or paid session per order, like Kashier', async () => {
    const gateway = fake();
    const session = await gateway.createSession(input('p-1'));
    expect(session.checkoutUrl).toMatch(/^http:\/\/localhost:3000\/fake-kashier\/session\//);
    await expect(gateway.createSession(input('p-1'))).rejects.toMatchObject({ kind: 'session_exists' });
    // An expired, unpaid session no longer blocks a new one.
    const expired = fake();
    await expired.createSession(input('p-2', -1));
    expect((await expired.createSession(input('p-2'))).sessionId).toHaveLength(24);
  });

  it('reports scripted statuses, outages, and verifies Kashier-signed webhooks', async () => {
    const gateway = fake();
    const { sessionId } = await gateway.createSession(input('p-3'));
    expect((await gateway.getSessionStatus(sessionId)).status).toBe('unpaid');
    gateway.setStatus(sessionId, 'paid');
    expect((await gateway.getSessionStatus(sessionId)).status).toBe('paid');
    gateway.startOutage();
    await expect(gateway.getSessionStatus(sessionId)).rejects.toMatchObject({ kind: 'unavailable' });
    gateway.endOutage();
    const { body, signature } = webhook();
    expect(gateway.verifyWebhook(body, signature)?.succeeded).toBe(true);
    expect(gateway.verifyWebhook(body, signKashierWebhook({}, ['x'], 'wrong'))).toBeNull();
  });
});

/** A local URL nothing listens on: the connection is refused before anything is sent. */
async function closedPortUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
