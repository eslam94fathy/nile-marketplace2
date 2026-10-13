import { AppError, type PgErrorMapper } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** identity error codes (docs/spec/03-identity.md §6). */
export const IdentityErrorCode = {
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  INVALID_OTP: 'INVALID_OTP',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  INVALID_INVITE_TOKEN: 'INVALID_INVITE_TOKEN',
  INVALID_CURRENT_PASSWORD: 'INVALID_CURRENT_PASSWORD',
  PASSWORD_UNCHANGED: 'PASSWORD_UNCHANGED',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_NOT_INVITED: 'USER_NOT_INVITED',
  USER_INVALID_STATUS_TRANSITION: 'USER_INVALID_STATUS_TRANSITION',
  CANNOT_SUSPEND_SELF: 'CANNOT_SUSPEND_SELF',
} as const;

const C = IdentityErrorCode;
const S = HTTP_STATUS;

export const emailAlreadyRegistered = (cause?: unknown) =>
  new AppError(C.EMAIL_ALREADY_REGISTERED, 'This email is already registered', S.CONFLICT, { cause });
/** One generic answer for unknown email, wrong password and invited accounts (no enumeration). */
export const invalidCredentials = () =>
  new AppError(C.INVALID_CREDENTIALS, 'Email or password is incorrect', S.UNAUTHORIZED);
export const emailNotVerified = () =>
  new AppError(C.EMAIL_NOT_VERIFIED, 'Verify your email address first', S.FORBIDDEN);
export const accountSuspended = () =>
  new AppError(C.ACCOUNT_SUSPENDED, 'This account is suspended', S.FORBIDDEN);
/** One generic answer for missing, expired, consumed, wrong or exhausted codes. */
export const invalidOtp = () =>
  new AppError(C.INVALID_OTP, 'The code is invalid or has expired', S.BAD_REQUEST);
export const invalidRefreshToken = () =>
  new AppError(C.INVALID_REFRESH_TOKEN, 'The session is invalid or has expired', S.UNAUTHORIZED);
export const invalidInviteToken = () =>
  new AppError(C.INVALID_INVITE_TOKEN, 'The invitation is invalid or has expired', S.BAD_REQUEST);
export const invalidCurrentPassword = () =>
  new AppError(C.INVALID_CURRENT_PASSWORD, 'The current password is incorrect', S.BAD_REQUEST);
export const passwordUnchanged = () =>
  new AppError(
    C.PASSWORD_UNCHANGED,
    'The new password must differ from the current one',
    S.UNPROCESSABLE_ENTITY,
  );
export const userNotFound = () => new AppError(C.USER_NOT_FOUND, 'User not found', S.NOT_FOUND);
export const userNotInvited = () =>
  new AppError(C.USER_NOT_INVITED, 'This user has no pending invitation', S.CONFLICT);
export const userInvalidStatusTransition = () =>
  new AppError(C.USER_INVALID_STATUS_TRANSITION, 'This status change is not allowed', S.CONFLICT);
export const cannotSuspendSelf = () =>
  new AppError(C.CANNOT_SUSPEND_SELF, 'You cannot suspend your own account', S.CONFLICT);

/** Unique constraints that race with app-level checks (CLAUDE.md §6.4). */
export function registerIdentityConstraintErrors(mapper: PgErrorMapper): void {
  mapper.register('uq_users_email', emailAlreadyRegistered);
}
