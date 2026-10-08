/** Values match the CHECK constraints in the identity migrations. */
export const UserStatus = {
  PENDING_EMAIL_VERIFICATION: 'pending_email_verification',
  INVITED: 'invited',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const VerificationPurpose = {
  EMAIL_VERIFICATION: 'email_verification',
  PASSWORD_RESET: 'password_reset',
  ACCOUNT_INVITE: 'account_invite',
} as const;
export type VerificationPurpose = (typeof VerificationPurpose)[keyof typeof VerificationPurpose];

/** OTP purposes (6-digit codes); invites use long random tokens instead. */
export type OtpPurpose =
  typeof VerificationPurpose.EMAIL_VERIFICATION | typeof VerificationPurpose.PASSWORD_RESET;
