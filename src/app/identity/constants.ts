export const IDENTITY_TABLES = {
  USERS: 'users',
  REFRESH_TOKENS: 'refresh_tokens',
  VERIFICATION_CODES: 'verification_codes',
} as const;

/** 6-digit OTP (docs/design/01-architecture.md §10). */
export const OTP_DIGITS = 6;
/** Opaque refresh / invite tokens: 32 random bytes → 43 base64url chars (spec 03 §4.5, §4.9). */
export const OPAQUE_TOKEN_BYTES = 32;
export const OPAQUE_TOKEN_LENGTH = 43;

/** Query parameter appended to INVITE_URL_BASE. */
export const INVITE_TOKEN_QUERY_PARAM = 'token';

/** `refresh_tokens.user_agent` is VARCHAR(255). */
export const MAX_DEVICE_NAME_LENGTH = 255;
