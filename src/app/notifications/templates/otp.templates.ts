import { codeHtml, escapeHtml, htmlBody, type RenderedEmail, textBody } from './layout';

export interface OtpVariables {
  otp: string;
  expiresInMinutes: number;
}

const minutes = (n: number): string => `${n} minute${n === 1 ? '' : 's'}`;

/** `email_verification` (spec 13 §3.1). */
export function renderEmailVerification(vars: OtpVariables): RenderedEmail {
  const subject = 'Your Nile verification code';
  const intro = 'Use this code to verify your email address:';
  const expiry = `The code expires in ${minutes(vars.expiresInMinutes)}.`;
  return {
    subject,
    text: textBody([intro, vars.otp, expiry]),
    html: htmlBody(subject, [escapeHtml(intro), codeHtml(vars.otp), escapeHtml(expiry)]),
  };
}

/** `password_reset` (spec 13 §3.1). */
export function renderPasswordReset(vars: OtpVariables): RenderedEmail {
  const subject = 'Reset your Nile password';
  const intro = 'Use this code to reset your password:';
  const expiry = `The code expires in ${minutes(vars.expiresInMinutes)}. Your password stays the same until you set a new one.`;
  return {
    subject,
    text: textBody([intro, vars.otp, expiry]),
    html: htmlBody(subject, [escapeHtml(intro), codeHtml(vars.otp), escapeHtml(expiry)]),
  };
}
