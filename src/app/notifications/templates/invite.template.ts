import { type UserRoleValue } from '../../../lib/events';
import { escapeHtml, htmlBody, type RenderedEmail, textBody } from './layout';

export interface InviteVariables {
  inviteUrl: string;
  role: UserRoleValue;
  /** ISO-8601 UTC. */
  expiresAt: string;
}

const ROLE_LABEL: Readonly<Record<UserRoleValue, string>> = {
  admin: 'an admin',
  delivery_agent: 'a delivery agent',
  customer: 'a customer',
  seller: 'a seller',
};

const EXPIRY_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** `account_invite` (spec 13 §3.1). */
export function renderAccountInvite(vars: InviteVariables): RenderedEmail {
  const subject = "You're invited to Nile";
  const intro = `You've been invited to join Nile as ${ROLE_LABEL[vars.role]}.`;
  const action = 'Open this link on your phone to set your password:';
  const expiry = `The invitation expires on ${EXPIRY_FORMAT.format(new Date(vars.expiresAt))} UTC.`;
  const url = escapeHtml(vars.inviteUrl);
  return {
    subject,
    text: textBody([intro, action, vars.inviteUrl, expiry]),
    html: htmlBody(subject, [
      escapeHtml(intro),
      escapeHtml(action),
      `<a href="${url}" style="color:#0b5cad">Accept the invitation</a><br><span style="font-size:13px;color:#666666;word-break:break-all">${url}</span>`,
      escapeHtml(expiry),
    ]),
  };
}
