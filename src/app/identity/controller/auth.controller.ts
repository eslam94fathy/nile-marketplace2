import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
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
import { type AuthService } from '../service/auth.service';

/** HTTP only (spec 03 §4.2–§4.9b): validate → one service call → envelope. */
@injectable()
export class AuthController {
  constructor(@inject(TOKENS.AuthService) private readonly auth: AuthService) {}

  verifyEmail = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(VerifyEmailDto, req.body);
    const session = await this.auth.verifyEmail(dto.email, dto.otp);
    sendSuccess(res, HTTP_STATUS.OK, toAuthTokensDto(session.user, session.tokens));
  };

  resendOtp = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(EmailOnlyDto, req.body);
    await this.auth.resendVerificationOtp(dto.email);
    sendSuccess<MessageDto>(res, HTTP_STATUS.OK, { message: GENERIC_MESSAGES.OTP_SENT });
  };

  login = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(LoginDto, req.body);
    const session = await this.auth.login(dto.email, dto.password, dto.deviceName ?? null);
    sendSuccess(res, HTTP_STATUS.OK, toAuthTokensDto(session.user, session.tokens));
  };

  refresh = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(RefreshTokenDto, req.body);
    const session = await this.auth.refresh(dto.refreshToken);
    sendSuccess(res, HTTP_STATUS.OK, toAuthTokensDto(session.user, session.tokens));
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(RefreshTokenDto, req.body);
    await this.auth.logout(dto.refreshToken);
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
    const session = await this.auth.acceptInvite(dto.token, dto.password);
    sendSuccess(res, HTTP_STATUS.OK, toAuthTokensDto(session.user, session.tokens));
  };

  changePassword = async (req: Request, res: Response): Promise<void> => {
    if (!req.auth) throw unauthenticated();
    const dto = await validateDto(ChangePasswordDto, req.body);
    await this.auth.changePassword(req.auth.userId, dto);
    sendNoContent(res);
  };
}
