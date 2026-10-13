import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TOKENS } from '../../../lib/di';
import { type NotificationEmailRequestedPayload, type OutboxEvent } from '../../../lib/events';
import { AesGcmSecretBox } from '../../../pkg/crypto';
import { IdentityEmailNotifier } from '../service/identity-email.notifier';
import { createFakes, FAKE_TRX } from './fakes';

function setup() {
  const fakes = createFakes();
  const secretBox = new AesGcmSecretBox({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });
  fakes.container.register(TOKENS.SecretBox, { useValue: secretBox });
  fakes.container.register(TOKENS.Env, {
    useValue: { OTP_TTL_MINUTES: 10, INVITE_URL_BASE: 'https://app.nile.test/invite?source=email' },
  });
  const event = () => fakes.outbox.add.mock.calls[0]?.[1] as OutboxEvent<NotificationEmailRequestedPayload>;
  return { ...fakes, secretBox, event, notifier: fakes.container.resolve(IdentityEmailNotifier) };
}

describe('identity IdentityEmailNotifier (S-1: secrets sealed in the outbox)', () => {
  it('queues an OTP email: plain variables, the OTP only inside encryptedSecrets', async () => {
    const { notifier, outbox, event, secretBox } = setup();
    await notifier.requestOtpEmail(FAKE_TRX, { userId: 'u-1', email: 'a@x.io' }, 'password_reset', '042917');

    expect(outbox.add).toHaveBeenCalledWith(FAKE_TRX, expect.anything());
    const { contract, aggregateId, payload } = event();
    expect(contract.type).toBe('notification.email_requested');
    expect(aggregateId).toBe('u-1');
    expect(payload).toMatchObject({
      template: 'password_reset',
      userId: 'u-1',
      toEmail: 'a@x.io',
      variables: { expiresInMinutes: 10 },
    });
    expect(JSON.stringify(payload)).not.toContain('042917');
    expect(JSON.parse(secretBox.open(payload.encryptedSecrets, 'u-1:password_reset'))).toEqual({
      otp: '042917',
    });
    // AAD binds the secret to this user + template.
    expect(() => secretBox.open(payload.encryptedSecrets, 'u-2:password_reset')).toThrow();
  });

  it('queues an invite email with the token appended to INVITE_URL_BASE, sealed', async () => {
    const { notifier, event, secretBox } = setup();
    const expiresAt = new Date('2026-10-11T12:00:00.000Z');
    await notifier.requestInviteEmail(
      FAKE_TRX,
      { userId: 'u-1', email: 'a@x.io' },
      'admin',
      'tok_en-123',
      expiresAt,
    );

    const { payload } = event();
    expect(payload).toMatchObject({
      template: 'account_invite',
      variables: { role: 'admin', expiresAt: '2026-10-11T12:00:00.000Z' },
    });
    expect(JSON.stringify(payload)).not.toContain('tok_en-123');
    const { inviteUrl } = JSON.parse(secretBox.open(payload.encryptedSecrets, 'u-1:account_invite')) as {
      inviteUrl: string;
    };
    expect(inviteUrl).toBe('https://app.nile.test/invite?source=email&token=tok_en-123');
  });
});
