import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
import { TimeUnit, toMs } from '../../../pkg/time';
import { GENERIC_MESSAGES } from '../constants';
import {
  AcceptInviteDto,
  ChangePasswordDto,
  EmailOnlyDto,
  LoginDto,
  RefreshTokenDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from '../dto/auth-request.dto';
import { type MessageDto, toAuthTokensDto } from '../dto/auth-response.dto';
import { type AuthService, type Session } from '../service/auth.service';
import { clearRefreshCookie, deliverRefreshToken, refreshTokenFrom } from './refresh-token-transport';

/** HTTP only (spec 03 §4.2–§4.9b, §8.1): validate → one service call → envelope. */
@injectable()
export class AuthController {
  constructor(
    @inject(TOKENS.AuthService) private readonly auth: AuthService,
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'REFRESH_TOKEN_TTL_DAYS'>,
  ) {}

  verifyEmail = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(VerifyEmailDto, req.body);
    this.sendSession(req, res, await this.auth.verifyEmail(dto.email, dto.otp));
  };

  resendOtp = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(EmailOnlyDto, req.body);
    await this.auth.resendVerificationOtp(dto.email);
    sendSuccess<MessageDto>(res, HTTP_STATUS.OK, { message: GENERIC_MESSAGES.OTP_SENT });
  };

  login = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(LoginDto, req.body);
    this.sendSession(req, res, await this.auth.login(dto.email, dto.password, dto.deviceName ?? null));
  };

  refresh = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(RefreshTokenDto, req.body);
    this.sendSession(req, res, await this.auth.refresh(refreshTokenFrom(req, dto.refreshToken)));
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(RefreshTokenDto, req.body);
    await this.auth.logout(refreshTokenFrom(req, dto.refreshToken));
    clearRefreshCookie(req, res);
    sendNoContent(res);
  };

  forgotPassword = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(EmailOnlyDto, req.body);
    await this.auth.forgotPassword(dto.email);
    sendSuccess<MessageDto>(res, HTTP_STATUS.OK, { message: GENERIC_MESSAGES.PASSWORD_RESET_SENT });
  };

  resetPassword = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(ResetPasswordDto, req.body);
    await this.auth.resetPassword(dto.email, dto.otp, dto.newPassword);
    sendNoContent(res);
  };

  acceptInvite = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(AcceptInviteDto, req.body);
    this.sendSession(req, res, await this.auth.acceptInvite(dto.token, dto.password));
  };

  changePassword = async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw unauthenticated();
    const dto = await validateDto(ChangePasswordDto, req.body);
    await this.auth.changePassword(req.auth.userId, {
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
      refreshToken: refreshTokenFrom(req, dto.refreshToken),
    });
    sendNoContent(res);
  };

  /** A new token pair; the refresh token's transport follows `X-Nile-Client` (spec 03 §8.1). */
  private sendSession(req: Request, res: Response, session: Session): void {
    const maxAgeMs = toMs(this.env.REFRESH_TOKEN_TTL_DAYS, TimeUnit.DAY);
    const refreshToken = deliverRefreshToken(req, res, session.tokens.refreshToken, maxAgeMs);
    sendSuccess(res, HTTP_STATUS.OK, toAuthTokensDto(session.user, session.tokens, refreshToken));
  }
}
