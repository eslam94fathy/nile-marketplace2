import { type Request, type Response } from 'express';
import { inject, injectable } from 'tsyringe';
import { type AuthContext, UserRole } from '../../../lib/auth';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { unauthenticated } from '../../../lib/error';
import { HTTP_STATUS, parseListQuery, sendNoContent, sendSuccess, validateDto } from '../../../lib/http';
import {
  CustomerOpenTicketDto,
  MESSAGE_LIST_SPEC,
  PostMessageDto,
  SellerOpenTicketDto,
  TicketIdParamsDto,
  USER_TICKET_LIST_SPEC,
} from '../dto/support-request.dto';
import { toTicketMessageDto, toTicketSummaryDto } from '../dto/support-response.dto';
import { type SupportTicketService } from '../service/support-ticket.service';
import { type SupportViewService } from '../service/support-view.service';

type ListEnv = Pick<Env, 'PAGINATION_DEFAULT_LIMIT' | 'PAGINATION_MAX_LIMIT'>;

/** HTTP only (spec 16 §4.1): the customer's or seller's own tickets. */
@injectable()
export class SupportTicketController {
  constructor(
    @inject(TOKENS.SupportTicketService) private readonly tickets: SupportTicketService,
    @inject(TOKENS.SupportViewService) private readonly views: SupportViewService,
    @inject(TOKENS.Env) private readonly env: ListEnv,
  ) {}

  open = async (req: Request, res: Response): Promise<void> => {
    const opener = callerOf(req);
    // Role-specific DTOs: `orderId` from a seller is an unknown key (400, spec 16 §4.1).
    const dto =
      opener.role === UserRole.SELLER
        ? await validateDto(SellerOpenTicketDto, req.body)
        : await validateDto(CustomerOpenTicketDto, req.body);
    const { ticket } = await this.tickets.open(opener, {
      ...dto,
      attachmentMediaIds: dto.attachmentMediaIds ?? [],
    });
    const [view] = await this.views.ticketViews(opener.userId, [ticket]);
    if (!view) throw new Error(`no view built for ticket ${ticket.id}`);
    sendSuccess(res, HTTP_STATUS.CREATED, toTicketSummaryDto(view));
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const page = await this.views.listForOpener(callerOf(req), this.listQuery(req, USER_TICKET_LIST_SPEC));
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toTicketSummaryDto), page.meta);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { ticketId } = await validateDto(TicketIdParamsDto, req.params);
    sendSuccess(
      res,
      HTTP_STATUS.OK,
      toTicketSummaryDto(await this.views.getForOpener(callerOf(req), ticketId)),
    );
  };

  messages = async (req: Request, res: Response): Promise<void> => {
    const { ticketId } = await validateDto(TicketIdParamsDto, req.params);
    const page = await this.views.messagesForOpener(
      callerOf(req),
      ticketId,
      this.listQuery(req, MESSAGE_LIST_SPEC),
    );
    sendSuccess(res, HTTP_STATUS.OK, page.items.map(toTicketMessageDto), page.meta);
  };

  post = async (req: Request, res: Response): Promise<void> => {
    const { ticketId } = await validateDto(TicketIdParamsDto, req.params);
    const dto = await validateDto(PostMessageDto, req.body);
    const { ticket, message } = await this.tickets.postAsOpener(callerOf(req), ticketId, {
      body: dto.body,
      attachmentMediaIds: dto.attachmentMediaIds ?? [],
    });
    const [view] = await this.views.messageViewsForOpener(ticket, [message]);
    if (!view) throw new Error(`no view built for message ${message.id}`);
    sendSuccess(res, HTTP_STATUS.CREATED, toTicketMessageDto(view));
  };

  read = async (req: Request, res: Response): Promise<void> => {
    const { ticketId } = await validateDto(TicketIdParamsDto, req.params);
    await this.tickets.markReadAsOpener(callerOf(req), ticketId);
    sendNoContent(res);
  };

  private listQuery(req: Request, spec: typeof USER_TICKET_LIST_SPEC) {
    return parseListQuery(req.query, spec, {
      defaultLimit: this.env.PAGINATION_DEFAULT_LIMIT,
      maxLimit: this.env.PAGINATION_MAX_LIMIT,
    });
  }
}

function callerOf(req: Request): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}
