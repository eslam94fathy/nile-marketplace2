import { randomUUID } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { TEST_JWT_KID, TEST_JWT_PRIVATE_KEY_PEM } from './test-env';

export interface TestTokenOptions {
  sub?: string;
  /** Any string, so tests can send roles the API must reject. */
  role?: string;
  kid?: string;
  issuer?: string;
  audience?: string;
  /** Seconds from now; negative = already expired. */
  expiresInSeconds?: number;
}

/** Signs an access token the way identity will (RS256 + kid), with knobs to break each claim. */
export async function signTestAccessToken(options: TestTokenOptions = {}): Promise<string> {
  const key = await importPKCS8(TEST_JWT_PRIVATE_KEY_PEM, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: options.role ?? 'customer' })
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? TEST_JWT_KID })
    .setSubject(options.sub ?? randomUUID())
    .setIssuer(options.issuer ?? 'nile-test')
    .setAudience(options.audience ?? 'nile-test-app')
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresInSeconds ?? 900))
    .sign(key);
}
