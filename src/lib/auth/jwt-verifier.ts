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

export interface JwtVerifierOptions {
  /** A user whose valid tokens must still be refused (a suspension, spec 03 I-11). */
  isBlocked?: (userId: string) => Promise<boolean>;
  /**
   * The block check itself failed (Redis down). The request goes on: the tokens expire within their
   * TTL anyway, and Redis is not a source of truth (architecture §8).
   */
  onBlockCheckError?: (error: unknown) => void;
}

/**
 * Verifies access tokens (architecture §10): algorithm pinned, `kid` selects the public key
 * (rotation-ready), `iss`/`aud`/`exp` enforced. Any failure is a generic UNAUTHENTICATED.
 */
export class JwtVerifier {
  private constructor(
    private readonly env: JwtEnv,
    private readonly keys: ReadonlyMap<string, CryptoKey>,
    private readonly options: JwtVerifierOptions,
  ) {}

  static async create(env: JwtEnv, options: JwtVerifierOptions = {}): Promise<JwtVerifier> {
    const keys = new Map<string, CryptoKey>();
    for (const [kid, pem] of Object.entries(env.JWT_PUBLIC_KEYS)) {
      keys.set(kid, await importSPKI(pem, env.JWT_ALGORITHM));
    }
    return new JwtVerifier(env, keys, options);
  }

  async verify(token: string): Promise<AuthContext> {
    const context = await this.verifySignature(token);
    if (await this.blocked(context.userId)) throw unauthenticated();
    return context;
  }

  private async verifySignature(token: string): Promise<AuthContext> {
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

  /** Fails open: a check that can't run lets the request through (see `onBlockCheckError`). */
  private async blocked(userId: string): Promise<boolean> {
    if (!this.options.isBlocked) return false;
    try {
      return await this.options.isBlocked(userId);
    } catch (error) {
      this.options.onBlockCheckError?.(error);
      return false;
    }
  }

  private keyFor(header: JWTHeaderParameters): CryptoKey {
    const key = header.kid ? this.keys.get(header.kid) : undefined;
    if (!key) throw unauthenticated();
    return key;
  }
}
