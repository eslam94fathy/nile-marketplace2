import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../templates/layout';
import { renderEmail } from '../templates';

describe('notifications templates (spec 13 §3.1)', () => {
  it('email_verification: subject, code and expiry in both parts', () => {
    const email = renderEmail({
      template: 'email_verification',
      variables: { otp: '042917', expiresInMinutes: 10 },
    });
    expect(email.subject).toBe('Your Nile verification code');
    for (const part of [email.text, email.html]) {
      expect(part).toContain('042917');
      expect(part).toContain('10 minutes');
    }
  });

  it('password_reset: its own subject; singular minute', () => {
    const email = renderEmail({
      template: 'password_reset',
      variables: { otp: '123456', expiresInMinutes: 1 },
    });
    expect(email.subject).toBe('Reset your Nile password');
    expect(email.text).toContain('1 minute.');
  });

  it('account_invite: link, role label and a UTC expiry date', () => {
    const email = renderEmail({
      template: 'account_invite',
      variables: {
        inviteUrl: 'https://app.nile.test/invite?token=abc&x=1',
        role: 'delivery_agent',
        expiresAt: '2026-10-11T12:00:00.000Z',
      },
    });
    expect(email.subject).toBe("You're invited to Nile");
    expect(email.text).toContain('https://app.nile.test/invite?token=abc&x=1');
    expect(email.text).toContain('as a delivery agent');
    expect(email.text).toContain('11 Oct 2026, 12:00 UTC');
    expect(email.html).toContain('href="https://app.nile.test/invite?token=abc&amp;x=1"');
  });

  it('escapes every variable in the HTML part', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    const email = renderEmail({
      template: 'account_invite',
      variables: { inviteUrl: 'https://x.test/"><script>', role: 'admin', expiresAt: '2026-10-11T12:00:00Z' },
    });
    expect(email.html).not.toContain('<script>');
  });

  it('never renders "undefined" or "NaN"', () => {
    const emails = [
      renderEmail({ template: 'email_verification', variables: { otp: '000000', expiresInMinutes: 5 } }),
      renderEmail({
        template: 'account_invite',
        variables: { inviteUrl: 'https://x.test/i', role: 'admin', expiresAt: '2026-01-01T00:00:00Z' },
      }),
    ];
    for (const email of emails) {
      expect(`${email.subject}${email.text}${email.html}`).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});
