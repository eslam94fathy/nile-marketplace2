import { createECDH, randomBytes } from 'node:crypto';
import webPush, { WebPushError } from 'web-push';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAllowedPushEndpoint, outcomeOf, WebPushSender } from '..';

const ALLOWLIST = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', '*.notify.windows.com'];

describe('outcomeOf (spec 13 UC-NO-3 step 3)', () => {
  it.each([
    [201, 'delivered'],
    [404, 'gone'],
    [410, 'gone'],
    [400, 'rejected'],
    [403, 'rejected'],
    [413, 'rejected'],
    [429, 'transient'],
    [500, 'transient'],
    [503, 'transient'],
  ] as const)('%i → %s', (status, outcome) => expect(outcomeOf(status)).toBe(outcome));
});

describe('isAllowedPushEndpoint (SSRF guard, UC-NO-4)', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://FCM.googleapis.com/fcm/send/abc',
  ])('allows %s', (url) => expect(isAllowedPushEndpoint(url, ALLOWLIST)).toBe(true));

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://user:pass@fcm.googleapis.com/x',
    'https://fcm.googleapis.com.evil.test/x',
    'https://evilfcm.googleapis.com/x',
    'https://notify.windows.com/x',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/x',
    'not a url',
  ])('refuses %s', (url) => expect(isAllowedPushEndpoint(url, ALLOWLIST)).toBe(false));
});

describe('WebPushSender', () => {
  afterEach(() => vi.restoreAllMocks());

  /** What a browser's PushSubscription carries: a P-256 key and 16 random bytes. */
  const browserKeys = () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
  };
  const vapid = webPush.generateVAPIDKeys();
  const sender = (timeoutMs = 2000) =>
    new WebPushSender({
      vapidPublicKey: vapid.publicKey,
      vapidPrivateKey: vapid.privateKey,
      vapidSubject: 'mailto:ops@nile.test',
      timeoutMs,
    });
  const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: browserKeys() };
  const message = { payload: '{"title":"Order placed"}', ttlSeconds: 86_400, urgency: 'high' } as const;

  it('the request it makes is encrypted (RFC 8291), VAPID-signed, with TTL and urgency; 201 is delivered', async () => {
    const send = vi
      .spyOn(webPush, 'sendNotification')
      .mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    expect(await sender().send(target, message)).toEqual({ outcome: 'delivered', statusCode: 201 });
    // Feed the exact arguments through the library's request builder (no network): what would go out.
    const [subscription, payload, options] = send.mock.calls[0] ?? [];
    if (!subscription || typeof payload !== 'string') throw new Error('not called');
    // The typings' overloads collapse to never here; the runtime shape is headers + body.
    const request = webPush.generateRequestDetails(subscription, payload, options) as unknown as {
      headers: Record<string, unknown>;
      body: Buffer | null;
    };
    expect(request.headers).toMatchObject({ TTL: 86_400, Urgency: 'high', 'Content-Encoding': 'aes128gcm' });
    expect(String(request.headers.Authorization)).toMatch(/^vapid t=.+, k=.+$/);
    expect(Buffer.from(request.body ?? '').toString()).not.toContain('Order placed');
  });

  it('maps a push service answer (WebPushError) and a failure without an answer', async () => {
    const send = vi.spyOn(webPush, 'sendNotification');
    send.mockRejectedValueOnce(new WebPushError('gone', 410, {}, '', target.endpoint));
    expect(await sender().send(target, message)).toEqual({ outcome: 'gone', statusCode: 410 });
    send.mockRejectedValueOnce(new WebPushError('busy', 503, {}, '', target.endpoint));
    expect(await sender().send(target, message)).toEqual({ outcome: 'transient', statusCode: 503 });
    send.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await sender().send(target, message)).toEqual({ outcome: 'transient' });
  });

  it('no answer within the timeout is transient (the whole request, not just socket inactivity)', async () => {
    vi.spyOn(webPush, 'sendNotification').mockReturnValue(new Promise(() => undefined));
    expect(await sender(50).send(target, message)).toEqual({ outcome: 'transient' });
  });
});
