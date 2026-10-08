import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AesGcmSecretBox,
  constantTimeEqual,
  randomNumericCode,
  randomToken,
  SecretBoxError,
  sha256Hex,
} from '..';

describe('pkg/crypto hashing and randomness', () => {
  it('hashes with SHA-256 hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('compares strings in constant time', () => {
    expect(constantTimeEqual('same', 'same')).toBe(true);
    expect(constantTimeEqual('same', 'sama')).toBe(false);
    expect(constantTimeEqual('short', 'longer-value')).toBe(false);
  });

  it('creates 43-char base64url tokens from 32 bytes', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
    expect(() => randomToken(8)).toThrow(RangeError);
  });

  it('creates numeric codes with leading zeros', () => {
    for (let i = 0; i < 200; i += 1) expect(randomNumericCode(6)).toMatch(/^\d{6}$/);
    expect(() => randomNumericCode(3)).toThrow(RangeError);
  });
});

describe('pkg/crypto AesGcmSecretBox', () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);

  it('round-trips with the same AAD', () => {
    const box = new AesGcmSecretBox({ keys: { k1 }, activeKeyId: 'k1' });
    const sealed = box.seal('{"otp":"123456"}', 'user-1:email_verification');
    expect(sealed).toMatch(/^v1\.k1\./);
    expect(sealed).not.toContain('123456');
    expect(box.open(sealed, 'user-1:email_verification')).toBe('{"otp":"123456"}');
  });

  it('uses a fresh IV per message', () => {
    const box = new AesGcmSecretBox({ keys: { k1 }, activeKeyId: 'k1' });
    expect(box.seal('x', 'a')).not.toBe(box.seal('x', 'a'));
  });

  it('rejects a different AAD, tampering, and malformed input', () => {
    const box = new AesGcmSecretBox({ keys: { k1 }, activeKeyId: 'k1' });
    const sealed = box.seal('secret', 'user-1:password_reset');
    expect(() => box.open(sealed, 'user-2:password_reset')).toThrow(SecretBoxError);

    const parts = sealed.split('.');
    const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    parts[3] = ciphertext.toString('base64url');
    expect(() => box.open(parts.join('.'), 'user-1:password_reset')).toThrow(SecretBoxError);

    expect(() => box.open('not-sealed', 'x')).toThrow(SecretBoxError);
    expect(() => box.open('v1.k9.a.b.c', 'x')).toThrow(/Unknown key id/);
  });

  it('supports key rotation: old messages still open after the active key changes', () => {
    const before = new AesGcmSecretBox({ keys: { k1 }, activeKeyId: 'k1' });
    const sealedWithK1 = before.seal('old', 'aad');
    const after = new AesGcmSecretBox({ keys: { k1, k2 }, activeKeyId: 'k2' });
    expect(after.open(sealedWithK1, 'aad')).toBe('old');
    expect(after.seal('new', 'aad')).toMatch(/^v1\.k2\./);
  });

  it('validates the key ring', () => {
    expect(() => new AesGcmSecretBox({ keys: { k1: randomBytes(16) }, activeKeyId: 'k1' })).toThrow(
      /32 bytes/,
    );
    expect(() => new AesGcmSecretBox({ keys: { k1 }, activeKeyId: 'k2' })).toThrow(/not in the key ring/);
    expect(() => new AesGcmSecretBox({ keys: { 'bad id': k1 }, activeKeyId: 'bad id' })).toThrow(
      /Invalid key id/,
    );
  });
});
