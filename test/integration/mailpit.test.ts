import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmailSender } from '../../src/infrastructure';
import { loadEnv, workerEnvSchema } from '../../src/lib/config';
import { testEnvInput } from '../helpers/test-env';

const MAILPIT_IMAGE = 'axllent/mailpit:v1.31.2';
const MAILPIT_HTTP_PORT = 8025;

interface MailpitMessage {
  ID: string;
  Subject: string;
  From: { Address: string; Name: string };
  To: { Address: string }[];
}

describe('Mailpit adapter against a real Mailpit (P1-Q2, development inbox)', () => {
  let mailpit: StartedTestContainer;
  let url: string;

  beforeAll(async () => {
    mailpit = await new GenericContainer(MAILPIT_IMAGE)
      .withExposedPorts(MAILPIT_HTTP_PORT)
      .withWaitStrategy(Wait.forHttp('/livez', MAILPIT_HTTP_PORT))
      .start();
    url = `http://${mailpit.getHost()}:${mailpit.getMappedPort(MAILPIT_HTTP_PORT)}`;
  });
  afterAll(async () => {
    await mailpit.stop();
  });

  it('createEmailSender(mailpit) delivers a message that shows up in the inbox', async () => {
    const env = loadEnv(workerEnvSchema, testEnvInput({ EMAIL_PROVIDER: 'mailpit', MAILPIT_URL: url }));
    const sender = createEmailSender(env);

    const result = await sender.send({
      to: { email: 'customer@example.com', name: 'Customer' },
      subject: 'Your Nile verification code',
      text: 'Your code is 123456',
      html: '<p>Your code is <b>123456</b></p>',
      customId: 'event-1',
    });
    expect(result.providerMessageId).toEqual(expect.any(String));

    const inbox = (await (await fetch(`${url}/api/v1/messages`)).json()) as { messages: MailpitMessage[] };
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({
      ID: result.providerMessageId,
      Subject: 'Your Nile verification code',
      From: { Address: 'no-reply@nile.test', Name: 'Nile Test' },
      To: [{ Address: 'customer@example.com' }],
    });
  });
});
