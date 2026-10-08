import { randomUUID } from 'node:crypto';
import { importPKCS8, SignJWT, type CryptoKey } from 'jose';
import { toSeconds, TimeUnit } from '../../pkg/time';
import { type IClock } from '../clock';
import { type Env } from '../config';
import { type UserRole } from './roles';

type JwtSignEnv = Pick<
  Env,
  | 'JWT_ALGORITHM'
  | 'JWT_ISSUER'
  | 'JWT_AUDIENCE'
  | 'JWT_PRIVATE_KEY'
  | 'JWT_ACTIVE_KID'
  | 'ACCESS_TOKEN_TTL_MINUTES'
>;

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

/**
 * Issues access tokens (architecture §10, P1-Q5). api only: the private key never reaches other processes.
 * Claims: sub (user id), role, iss, aud, iat, exp, jti. Header: alg (pinned), kid (rotation).
 */
export class JwtSigner {
  private constructor(
    private readonly env: JwtSignEnv,
    private readonly key: CryptoKey,
    private readonly clock: IClock,
  ) {}

  static async create(env: JwtSignEnv, clock: IClock): Promise<JwtSigner> {
    return new JwtSigner(env, await importPKCS8(env.JWT_PRIVATE_KEY, env.JWT_ALGORITHM), clock);
  }

  async signAccessToken(subject: { userId: string; role: UserRole }): Promise<SignedAccessToken> {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);
    const expiresAt = issuedAt + toSeconds(this.env.ACCESS_TOKEN_TTL_MINUTES, TimeUnit.MINUTE);
    const token = await new SignJWT({ role: subject.role })
      .setProtectedHeader({ alg: this.env.JWT_ALGORITHM, kid: this.env.JWT_ACTIVE_KID, typ: 'JWT' })
      .setSubject(subject.userId)
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience(this.env.JWT_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(randomUUID())
      .sign(this.key);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }
}
