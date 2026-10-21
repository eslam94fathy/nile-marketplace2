import { type RequestHandler, Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, byUser, RateLimitClass, type RateLimiters, requireRole } from '../../lib/middleware';
import { SUPPORT_PATHS as P } from './constants';
import { type SupportTicketController } from './controller/support-ticket.controller';
import { CustomerOpenTicketDto, PostMessageDto } from './dto/support-request.dto';
import { TicketMessageDto, TicketSummaryDto } from './dto/support-response.dto';
import { TicketCategory, TicketStatus } from './enums';

const TAGS = ['support'] as const;

export interface SupportRouteDeps {
  tickets: SupportTicketController;
  jwtVerifier: JwtVerifier;
  rateLimiters: RateLimiters;
  /** `requireIdempotency`, required on ticket open and message post (SU-1, G25). */
  idempotency: RequestHandler;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/** Spec 16 §4.1: customers and sellers, their own tickets. */
export function supportRoutes(deps: SupportRouteDeps): Router {
  const { tickets: c, docs, basePath } = deps;
  const router = Router();
  const openers = [authenticate(deps.jwtVerifier), requireRole(UserRole.CUSTOMER, UserRole.SELLER)];
  // Rate limit first: a flood is refused before it takes an idempotency lock.
  const writes = [deps.rateLimiters.limit(RateLimitClass.SUPPORT_MESSAGE, byUser), deps.idempotency];

  router.post(P.TICKETS, ...openers, ...writes, c.open);
  router.get(P.TICKETS, ...openers, c.list);
  router.get(P.TICKET, ...openers, c.get);
  router.get(P.MESSAGES, ...openers, c.messages);
  router.post(P.MESSAGES, ...openers, ...writes, c.post);
  router.post(P.READ, ...openers, c.read);

  const common = { tags: TAGS, auth: true } as const;
  const page = [
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
    { name: 'cursor', in: 'query', schema: { type: 'string' } },
  ] as const;
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.TICKETS}`,
    summary:
      'Open a ticket with its first message. Customers: CustomerOpenTicketDto (optional orderId, and a sellerOrderId of that order). Sellers: SellerOpenTicketDto (optional sellerOrderId; orderId is refused). (SUPPORT_CATEGORY_NOT_ALLOWED, ORDER_NOT_FOUND, SELLER_ORDER_NOT_FOUND, SUPPORT_OPEN_TICKET_LIMIT_REACHED, MEDIA_NOT_ATTACHABLE: all 422)',
    idempotent: true,
    requestBody: CustomerOpenTicketDto,
    responses: { 201: { description: 'The new ticket', body: TicketSummaryDto } },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.TICKETS}`,
    summary:
      'My tickets, latest activity first. Filters: status[eq|in], category[eq|in], createdAt[gte|lte]. Sort: lastMessageAt (default -lastMessageAt), createdAt',
    query: [
      ...page,
      {
        name: 'sort',
        in: 'query',
        schema: { enum: ['lastMessageAt', '-lastMessageAt', 'createdAt', '-createdAt'] },
      },
      { name: 'status[eq]', in: 'query', schema: { enum: Object.values(TicketStatus) } },
      { name: 'status[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'category[eq]', in: 'query', schema: { enum: Object.values(TicketCategory) } },
      { name: 'category[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'createdAt[gte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'createdAt[lte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
    responses: {
      200: { description: 'One page of tickets', body: TicketSummaryDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.TICKET}`,
    summary: 'One of my tickets (SUPPORT_TICKET_NOT_FOUND)',
    responses: { 200: { description: 'The ticket', body: TicketSummaryDto } },
  });
  docs.add({
    ...common,
    method: 'get',
    path: `${basePath}${P.MESSAGES}`,
    summary:
      'The timeline of my ticket, newest first (reverse it to show). Attachment URLs are short-lived (SUPPORT_TICKET_NOT_FOUND)',
    query: [...page, { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] } }],
    responses: {
      200: { description: 'One page of messages', body: TicketMessageDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.MESSAGES}`,
    summary:
      'Write to support; reopens a resolved ticket (SUPPORT_TICKET_NOT_FOUND, SUPPORT_TICKET_CLOSED 409, MEDIA_NOT_ATTACHABLE 422)',
    idempotent: true,
    requestBody: PostMessageDto,
    responses: { 201: { description: 'The message', body: TicketMessageDto } },
  });
  docs.add({
    ...common,
    method: 'post',
    path: `${basePath}${P.READ}`,
    summary: 'Mark my ticket read (SUPPORT_TICKET_NOT_FOUND)',
    responses: { 204: { description: 'Read' } },
  });
  return router;
}
