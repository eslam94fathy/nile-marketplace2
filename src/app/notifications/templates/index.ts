import { EmailTemplateName } from '../enums';
import { renderAccountInvite, type InviteVariables } from './invite.template';
import { type RenderedEmail } from './layout';
import { type OtpVariables, renderEmailVerification, renderPasswordReset } from './otp.templates';

export type { RenderedEmail } from './layout';
export type { InviteVariables } from './invite.template';
export type { OtpVariables } from './otp.templates';

/** Template name → its full variable set (plain + decrypted secrets). */
export type RenderRequest =
  | { template: typeof EmailTemplateName.EMAIL_VERIFICATION; variables: OtpVariables }
  | { template: typeof EmailTemplateName.PASSWORD_RESET; variables: OtpVariables }
  | { template: typeof EmailTemplateName.ACCOUNT_INVITE; variables: InviteVariables };

export function renderEmail(request: RenderRequest): RenderedEmail {
  switch (request.template) {
    case EmailTemplateName.EMAIL_VERIFICATION:
      return renderEmailVerification(request.variables);
    case EmailTemplateName.PASSWORD_RESET:
      return renderPasswordReset(request.variables);
    case EmailTemplateName.ACCOUNT_INVITE:
      return renderAccountInvite(request.variables);
  }
}
