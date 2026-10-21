import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type AuthContext } from '../../../lib/auth';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { invalidQuery, unauthenticated } from '../../../lib/error';
import {
  HTTP_STATUS,
  type ParsedListQuery,
  parseListQuery,
  sendNoContent,
  sendSuccess,
  validateDto,
} from '../../../lib/http';
import {
  ADMIN_TICKET_LIST_SPEC,
  AdminPostMessageDto,
  AssignTicketDto,
  MESSAGE_LIST_SPEC,
  TicketIdParamsDto,
} from '../dto/support-request.dto';
import { toAdminTicketSummaryDto, toTicketMessageDto } from '../dto/support-response.dto';
import { type AdminTicketFilters } from '../repository/support-ticket.repository';
import { type SupportAdminService } from '../service/support-admin.service';
import { type SupportViewService } from '../service/support-view.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 16 §4.2): every ticket, for any admin. */
@injectable()
export class SupportAdminController {
  constructor(
    @inject(TOKENS.SupportAdminService) private readonly admin: SupportAdminService,
    @inject(TOKENS.SupportViewService) private readonly views: SupportViewService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseListQuery(req.query, ADMIN_TICKET_LIST_SPEC, this.limits());
    const page = await this.views.listForAdmin(callerOf(req), query, adminFilters(query));
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toAdminTicketSummaryDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { ticketId } = await validateDto(TicketIdParamsDto, req.params);
    const view = await this.views.getForAdmin(callerOf(req), ticketId);
    sendSuccess(res, HTTP_STATUS.OK, toAdminTicketSummaryDto(view));
  };

  messages = async (req: Request, res: Response): Promise<void> => {
    const { ticketId } = await validateDto(TicketIdParamsDto, req.params);
    const query = parseListQuery(req.query, MESSAGE_LIST_SPEC, this.limits());
    const page = await this.views.messagesForAdmin(callerOf(req), ticketId, query);
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toTicketMessageDto), page.meta);
  };

  post = async (req: Request, res: Response): Promise<void> => {
    const caller = callerOf(req);
    const { ticketId } = await validateDto(TicketIdParamsDto, req.params);
    const dto = await validateDto(AdminPostMessageDto, req.body);
    const { ticket, message } = await this.admin.post(caller, ticketId, {
      body: dto.body,
      attachmentMediaIds: dto.attachmentMediaIds ?? [],
      internal: dto.internal ?? false,
    });
    const [view] = await this.views.messageViewsForAdmin(caller.userId, ticket, [message]);
    if (!view) throw new Error(`no view built for message ${message.id}`);
    sendSuccess(res, HTTP_STATUS.CREATED, toTicketMessageDto(view));
  };

  assign = async (req: Request, res: Response): Promise<void> => {
    const { ticketId } = await validateDto(TicketIdParamsDto, req.params);
    const { adminUserId } = await validateDto(AssignTicketDto, req.body);
    await this.admin.assign(ticketId, adminUserId);
    await this.respondWithTicket(req, res, ticketId);
  };

  resolve = async (req: Request, res: Response): Promise<void> => {
    const { ticketId } = await validateDto(TicketIdParamsDto, req.params);
    await this.admin.resolve(ticketId);
    await this.respondWithTicket(req, res, ticketId);
  };

  close = async (req: Request, res: Response): Promise<void> => {
    const { ticketId } = await validateDto(TicketIdParamsDto, req.params);
    await this.admin.close(ticketId);
    await this.respondWithTicket(req, res, ticketId);
  };

  read = async (req: Request, res: Response): Promise<void> => {
    const { ticketId } = await validateDto(TicketIdParamsDto, req.params);
    await this.admin.markRead(callerOf(req), ticketId);
    sendNoContent(res);
  };

  private async respondWithTicket(req: Request, res: Response, ticketId: string): Promise<void> {
    const view = await this.views.getForAdmin(callerOf(req), ticketId);
    sendSuccess(res, HTTP_STATUS.OK, toAdminTicketSummaryDto(view));
  }

  private limits() {
    return { defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT, maxLimit: this.env.PAGINATION_MAX_LIMIT };
  }
}

/** The custom filters; `assigned` with `assignedAdminId` is ambiguous (spec 16 §4.2: 400 INVALID_QUERY). */
function adminFilters(query: ParsedListQuery): AdminTicketFilters {
  const boolean = (field: string) => {
    const value = query.filters.find((filter) => filter.field === field)?.value;
    return typeof value === 'boolean' ? value : undefined;
  };
  const assigned = boolean('assigned');
  if (assigned !== undefined && query.filters.some((filter) => filter.field === 'assignedAdminId')) {
    throw invalidQuery([
      {
        field: 'assigned',
        constraint: 'conflict',
        message: 'filter on assigned or on assignedAdminId, not both',
      },
    ]);
  }
  return {
    assigned,
    slaBreached: boolean('slaBreached'),
    waitingOnly: query.sort.field === 'awaitingAdminSince',
  };
}

function callerOf(req: Request): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}
