import bcrypt from 'bcrypt';

/** Password hashing (CLAUDE.md §10, D10). The cost factor always comes from config, never code. */
export interface IPasswordHasher {
  hash(plain: string): Promise<string>;
  /** Constant-time comparison (bcrypt). False for a malformed hash instead of throwing. */
  verify(plain: string, hash: string): Promise<boolean>;
}

/** bcrypt only reads the first 72 bytes; DTOs enforce the limit (`@MaxBytes(72)`), this is the backstop. */
export const BCRYPT_MAX_BYTES = 72;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export class BcryptPasswordHasher implements IPasswordHasher {
  constructor(private readonly cost: number) {
    if (!Number.isInteger(cost) || cost < 10 || cost > 15) {
      throw new RangeError(`bcrypt cost must be an integer between 10 and 15, got ${cost}`);
    }
  }

  async hash(plain: string): Promise<string> {
    assertLength(plain);
    return bcrypt.hash(plain, this.cost);
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    if (Buffer.byteLength(plain, 'utf8') > BCRYPT_MAX_BYTES || !BCRYPT_HASH_PATTERN.test(hash)) return false;
    return bcrypt.compare(plain, hash);
  }
}

function assertLength(plain: string): void {
  if (plain.length === 0 || Buffer.byteLength(plain, 'utf8') > BCRYPT_MAX_BYTES) {
    throw new RangeError(`Password must be 1..${BCRYPT_MAX_BYTES} UTF-8 bytes`);
  }
}
