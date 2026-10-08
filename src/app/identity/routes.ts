import { type Request, Router } from 'express';
import { type JwtVerifier } from '../../lib/auth';
import { type OpenApiRegistry, type RouteDoc } from '../../lib/http';
import {
  authenticate,
  byIp,
  byIpAndEmail,
  emailRateKey,
  RateLimitClass,
  type RateLimiters,
} from '../../lib/middleware';
import { IDENTITY_PATHS as P } from './constants';
import { type AuthController } from './controller/auth.controller';
import {
  AcceptInviteDto,
  ChangePasswordDto,
  EmailOnlyDto,
  LoginDto,
  RefreshTokenDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/auth-request.dto';
import { AuthTokensDto, MessageDto } from './dto/auth-response.dto';

const TAGS = ['auth'] as const;

export interface IdentityRouteDeps {
  auth: AuthController;
  jwtVerifier: JwtVerifier;
  rateLimiters: RateLimiters;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
  /** Account email of the authenticated caller (change-password rate limit). */
  emailOf: (userId: string) => Promise<string | undefined>;
}

export function identityRoutes(deps: IdentityRouteDeps): Router {
  const { auth, rateLimiters, docs } = deps;
  const router = Router();
  const strictAuth = rateLimiters.limit(RateLimitClass.STRICT_AUTH, byIpAndEmail);
  const refreshLimit = rateLimiters.limit(RateLimitClass.REFRESH, byIp);
  // Spec 03 §4.9b: IP + the account's email, sharing the login counter of that email.
  const strictAuthByAccount = rateLimiters.limit(RateLimitClass.STRICT_AUTH, async (req: Request) => {
    const email = req.auth ? await deps.emailOf(req.auth.userId) : undefined;
    return email ? [...byIp(req), emailRateKey(email)] : byIp(req);
  });

  router.post(P.VERIFY_EMAIL, strictAuth, auth.verifyEmail);
  router.post(P.RESEND_OTP, strictAuth, auth.resendOtp);
  router.post(P.LOGIN, strictAuth, auth.login);
  router.post(P.REFRESH, refreshLimit, auth.refresh);
  router.post(P.LOGOUT, refreshLimit, auth.logout);
  router.post(P.FORGOT_PASSWORD, strictAuth, auth.forgotPassword);
  router.post(P.RESET_PASSWORD, strictAuth, auth.resetPassword);
  router.post(P.ACCEPT_INVITE, strictAuth, auth.acceptInvite);
  router.post(P.CHANGE_PASSWORD, authenticate(deps.jwtVerifier), strictAuthByAccount, auth.changePassword);

  const doc = (
    path: string,
    summary: string,
    requestBody: NonNullable<RouteDoc['requestBody']>,
    responses: RouteDoc['responses'],
    authRequired = false,
  ) =>
    docs.add({
      method: 'post',
      path: `${deps.basePath}${path}`,
      summary,
      tags: TAGS,
      auth: authRequired,
      requestBody,
      responses,
    });
  const tokens = { 200: { description: 'Logged in: a new token pair', body: AuthTokensDto } };
  const noContent = { 204: { description: 'Done' } };
  const message = { 200: { description: 'Generic answer, the same for every outcome', body: MessageDto } };

  doc(P.VERIFY_EMAIL, 'Verify the email with the OTP and log in (INVALID_OTP)', VerifyEmailDto, tokens);
  doc(P.RESEND_OTP, 'Send a new email-verification OTP (cooldown applies)', EmailOnlyDto, message);
  doc(P.LOGIN, 'Log in (INVALID_CREDENTIALS, EMAIL_NOT_VERIFIED, ACCOUNT_SUSPENDED)', LoginDto, tokens);
  doc(
    P.REFRESH,
    'Rotate the refresh token; reusing an old one revokes the session (INVALID_REFRESH_TOKEN)',
    RefreshTokenDto,
    { 200: { description: 'A new token pair', body: AuthTokensDto } },
  );
  doc(P.LOGOUT, "End this device's session (always 204)", RefreshTokenDto, noContent);
  doc(P.FORGOT_PASSWORD, 'Send a password-reset OTP to an active account', EmailOnlyDto, message);
  doc(
    P.RESET_PASSWORD,
    'Set a new password with the OTP; every session is revoked (INVALID_OTP)',
    ResetPasswordDto,
    noContent,
  );
  doc(
    P.ACCEPT_INVITE,
    'Accept an invite: set the password and log in (INVALID_INVITE_TOKEN)',
    AcceptInviteDto,
    tokens,
  );
  doc(
    P.CHANGE_PASSWORD,
    'Change the password; other sessions are revoked (INVALID_CURRENT_PASSWORD, PASSWORD_UNCHANGED, INVALID_REFRESH_TOKEN)',
    ChangePasswordDto,
    noContent,
    true,
  );
  return router;
}
