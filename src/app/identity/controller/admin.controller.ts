import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
import { UserStatus } from '../enums';
import { ADMIN_LIST_SPEC, InviteAdminDto, SuspendUserDto, UserIdParamsDto } from '../dto/admin-request.dto';
import { toAdminListItemDto, toInvitedAdminDto, toUserStatusDto } from '../dto/admin-response.dto';
import { ADMIN_SUSPENDABLE_ROLES, type UserAdminService } from '../service/user-admin.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 03 §4.10–§4.13). Routes are admin-guarded. */
@injectable()
export class AdminController {
  constructor(
    @inject(TOKENS.UserAdminService) private readonly admin: UserAdminService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  inviteAdmin = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateDto(InviteAdminDto, req.body);
    const user = await this.admin.inviteAdmin(dto.email, actorOf(req));
    sendSuccess(res, HTTP_STATUS.CREATED, toInvitedAdminDto(user));
  };

  listAdmins = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, ADMIN_LIST_SPEC, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
    const page = await this.admin.listAdmins(query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toAdminListItemDto), page.meta);
  };

  resendInvite = async (req: Request, res: Response): Promise<void> => {
    const { userId } = await validateDto(UserIdParamsDto, req.params);
    await this.admin.resendInvite(userId);
    sendNoContent(res);
  };

  suspend = async (req: Request, res: Response): Promise<void> => {
    const { userId } = await validateDto(UserIdParamsDto, req.params);
    const dto = await validateDto(SuspendUserDto, req.body);
    const user = await this.admin.setStatus(userId, UserStatus.SUSPENDED, {
      actorUserId: actorOf(req),
      reason: dto.reason,
      allowedRoles: ADMIN_SUSPENDABLE_ROLES,
    });
    sendSuccess(res, HTTP_STATUS.OK, toUserStatusDto(user));
  };

  reactivate = async (req: Request, res: Response): Promise<void> => {
    const { userId } = await validateDto(UserIdParamsDto, req.params);
    const user = await this.admin.setStatus(userId, UserStatus.ACTIVE, {
      actorUserId: actorOf(req),
      allowedRoles: ADMIN_SUSPENDABLE_ROLES,
    });
    sendSuccess(res, HTTP_STATUS.OK, toUserStatusDto(user));
  };
}

function actorOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.userId;
}
