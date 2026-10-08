import { importSPKI, jwtVerify, type CryptoKey, type JWTHeaderParameters } from 'jose';
import { type Env } from '../config';
import { unauthenticated } from '../error/common-errors';
import { isUserRole, type UserRole } from './roles';

export interface AuthContext {
  userId: string;
  role: UserRole;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type JwtEnv = Pick<Env, 'JWT_ALGORITHM' | 'JWT_ISSUER' | 'JWT_AUDIENCE' | 'JWT_PUBLIC_KEYS'>;

/**
 * Verifies access tokens (architecture §10): algorithm pinned, `kid` selects the public key
 * (rotation-ready), `iss`/`aud`/`exp` enforced. Any failure is a generic UNAUTHENTICATED.
 */
export class JwtVerifier {
  private constructor(
    private readonly env: JwtEnv,
    private readonly keys: ReadonlyMap<string, CryptoKey>,
  ) {}

  static async create(env: JwtEnv): Promise<JwtVerifier> {
    const keys = new Map<string, CryptoKey>();
    for (const [kid, pem] of Object.entries(env.JWT_PUBLIC_KEYS)) {
      keys.set(kid, await importSPKI(pem, env.JWT_ALGORITHM));
    }
    return new JwtVerifier(env, keys);
  }

  async verify(token: string): Promise<AuthContext> {
    try {
      const { payload } = await jwtVerify(token, (header: JWTHeaderParameters) => this.keyFor(header), {
        algorithms: [this.env.JWT_ALGORITHM],
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      const { sub, role } = payload as { sub?: unknown; role?: unknown };
      if (typeof sub !== 'string' || !UUID_PATTERN.test(sub) || !isUserRole(role)) throw unauthenticated();
      return { userId: sub, role };
    } catch {
      throw unauthenticated();
    }
  }

  private keyFor(header: JWTHeaderParameters): CryptoKey {
    const key = header.kid ? this.keys.get(header.kid) : undefined;
    if (!key) throw unauthenticated();
    return key;
  }
}
