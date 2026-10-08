import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Authenticated encryption of small secrets (docs/spec/02-events.md §3.1). */
export interface ISecretBox {
  seal(plaintext: string, aad: string): string;
  open(sealed: string, aad: string): string;
}

export class SecretBoxError extends Error {
  override readonly name = 'SecretBoxError';
}

const FORMAT_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export interface SecretBoxKeyRing {
  keys: Readonly<Record<string, Buffer>>;
  activeKeyId: string;
}

/** Sealed format: `v1.<keyId>.<iv>.<ciphertext>.<authTag>` (base64url parts). */
export class AesGcmSecretBox implements ISecretBox {
  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly activeKeyId: string;

  constructor(ring: SecretBoxKeyRing) {
    const entries = Object.entries(ring.keys);
    for (const [id, key] of entries) {
      if (!KEY_ID_PATTERN.test(id)) throw new SecretBoxError(`Invalid key id "${id}"`);
      if (key.length !== KEY_BYTES) throw new SecretBoxError(`Key "${id}" must be ${KEY_BYTES} bytes`);
    }
    this.keys = new Map(entries);
    if (!this.keys.has(ring.activeKeyId)) {
      throw new SecretBoxError(`Active key "${ring.activeKeyId}" is not in the key ring`);
    }
    this.activeKeyId = ring.activeKeyId;
  }

  seal(plaintext: string, aad: string): string {
    const key = this.requireKey(this.activeKeyId);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      FORMAT_VERSION,
      this.activeKeyId,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  open(sealed: string, aad: string): string {
    const parts = sealed.split('.');
    if (parts.length !== 5 || parts[0] !== FORMAT_VERSION) {
      throw new SecretBoxError('Malformed sealed value');
    }
    const [, keyId = '', ivPart = '', ciphertextPart = '', tagPart = ''] = parts;
    const key = this.requireKey(keyId);
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretBoxError('Malformed sealed value');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart, 'base64url')),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch (cause) {
      throw new SecretBoxError('Sealed value failed authentication', { cause });
    }
  }

  private requireKey(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw new SecretBoxError(`Unknown key id "${keyId}"`);
    return key;
  }
}
