import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EmailSendError, MailjetEmailSender, MailpitEmailSender } from '..';

interface Captured {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/** A local stand-in for the provider: records the request, answers with the scripted response. */
let server: Server;
let baseUrl: string;
let captured: Captured | undefined;
let reply: { status: number; body: string; delayMs?: number };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      captured = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw) as unknown };
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

const message = {
  to: { email: 'customer@example.com', name: 'Customer' },
  subject: 'Your code',
  text: 'Code: 123456',
  html: '<p>Code: 123456</p>',
  customId: 'event-1',
};

describe('pkg/email MailjetEmailSender', () => {
  const sender = () =>
    new MailjetEmailSender({
      apiKey: 'key',
      secretKey: 'secret',
      from: { email: 'no-reply@nile.test', name: 'Nile' },
      timeoutMs: 500,
      baseUrl,
    });

  it('sends one message through the v3.1 API with basic auth and returns the message UUID', async () => {
    reply = {
      status: 200,
      body: JSON.stringify({ Messages: [{ Status: 'success', To: [{ MessageUUID: 'uuid-1' }] }] }),
    };
    await expect(sender().send(message)).resolves.toEqual({ providerMessageId: 'uuid-1' });
    expect(captured?.method).toBe('POST');
    expect(captured?.url).toBe('/v3.1/send');
    expect(captured?.headers.authorization).toBe(`Basic ${Buffer.from('key:secret').toString('base64')}`);
    expect(captured?.body).toEqual({
      Messages: [
        {
          From: { Email: 'no-reply@nile.test', Name: 'Nile' },
          To: [{ Email: 'customer@example.com', Name: 'Customer' }],
          Subject: 'Your code',
          TextPart: 'Code: 123456',
          HTMLPart: '<p>Code: 123456</p>',
          CustomID: 'event-1',
        },
      ],
    });
  });

  it.each([
    [400, true],
    [401, false],
    [429, false],
    [500, false],
    [503, false],
  ])('HTTP %i → EmailSendError(permanent=%s)', async (status, permanent) => {
    reply = { status, body: '{"ErrorMessage":"x"}' };
    const error = await sender()
      .send(message)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmailSendError);
    expect(error).toMatchObject({ permanent, status });
  });

  it('a timeout is transient', async () => {
    reply = { status: 200, body: '{}', delayMs: 1_000 };
    await expect(sender().send(message)).rejects.toMatchObject({ permanent: false, status: null });
  });

  it('never puts the credentials in an error message', async () => {
    reply = { status: 401, body: '{"ErrorMessage":"API key authentication/authorization failure"}' };
    const error = (await sender()
      .send(message)
      .catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain('secret');
  });
});

describe('pkg/email MailpitEmailSender', () => {
  it('sends through the Mailpit HTTP API and returns its ID', async () => {
    reply = { status: 200, body: '{"ID":"mp-1"}' };
    const sender = new MailpitEmailSender({
      url: `${baseUrl}/`,
      from: { email: 'dev@nile.local', name: 'Nile' },
      timeoutMs: 500,
    });
    await expect(sender.send(message)).resolves.toEqual({ providerMessageId: 'mp-1' });
    expect(captured?.url).toBe('/api/v1/send');
    expect(captured?.body).toEqual({
      From: { Email: 'dev@nile.local', Name: 'Nile' },
      To: [{ Email: 'customer@example.com', Name: 'Customer' }],
      Subject: 'Your code',
      Text: 'Code: 123456',
      HTML: '<p>Code: 123456</p>',
      Headers: { 'X-Nile-Ref': 'event-1' },
    });
  });
});
