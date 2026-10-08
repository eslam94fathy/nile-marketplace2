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

/** DTO limits (docs/spec/01-api-conventions.md §1.1, spec 03 §4). */
export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 8;
export const DEVICE_NAME_MAX_LENGTH = 100;

/** Paths under /api/v1 (spec 03 §4). */
export const IDENTITY_PATHS = {
  VERIFY_EMAIL: '/auth/email/verify',
  RESEND_OTP: '/auth/email/resend-otp',
  LOGIN: '/auth/login',
  REFRESH: '/auth/refresh',
  LOGOUT: '/auth/logout',
  FORGOT_PASSWORD: '/auth/password/forgot',
  RESET_PASSWORD: '/auth/password/reset',
  CHANGE_PASSWORD: '/auth/password/change',
  ACCEPT_INVITE: '/auth/invite/accept',
} as const;

/** Same text for every outcome, so the answer doesn't reveal whether the account exists. */
export const GENERIC_MESSAGES = {
  OTP_SENT: 'If the account can receive a code, a new one has been sent',
  PASSWORD_RESET_SENT: 'If an active account uses this email, a reset code has been sent',
} as const;

export const ADMIN_PATHS = {
  ADMINS: '/admin/admins',
  RESEND_INVITE: '/admin/users/:userId/resend-invite',
  SUSPEND: '/admin/users/:userId/suspend',
  REACTIVATE: '/admin/users/:userId/reactivate',
} as const;

export const SUSPEND_REASON_MIN_LENGTH = 3;
export const SUSPEND_REASON_MAX_LENGTH = 500;
