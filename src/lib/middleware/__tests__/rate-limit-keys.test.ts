import { describe, expect, it } from 'vitest';
import { emailRateKey } from '../rate-limit';

/* P8 security review F-6: the per-email key had the size of whatever the client sent. */
describe('lib/middleware emailRateKey', () => {
  it('is one fixed-size key per normalised email, with no email in it', () => {
    const key = emailRateKey('  Mona@Example.COM ');
    expect(key).toBe(emailRateKey('mona@example.com'));
    expect(key).toMatch(/^email:[0-9a-f]{64}$/);
    expect(key).not.toContain('mona');
    expect(emailRateKey(`${'x'.repeat(100_000)}@example.com`)).toHaveLength(key.length);
    expect(emailRateKey('other@example.com')).not.toBe(key);
  });
});
