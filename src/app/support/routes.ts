import { type RequestHandler, Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, byUser, RateLimitClass, type RateLimiters, requireRole } from '../../lib/middleware';
import { ADMIN_SUPPORT_PATHS as A, SUPPORT_PATHS as P } from './constants';
import { type SupportAdminController } from './controller/support-admin.controller';
import { type SupportTicketController } from './controller/support-ticket.controller';
import {
  AdminPostMessageDto,
  AssignTicketDto,
  CustomerOpenTicketDto,
  PostMessageDto,
} from './dto/support-request.dto';
import { AdminTicketSummaryDto, TicketMessageDto, TicketSummaryDto } from './dto/support-response.dto';
import { TicketCategory, TicketOpenerRole, TicketStatus } from './enums';

const TAGS = ['support'] as const;

export interface SupportRouteDeps {
  tickets: SupportTicketController;
  admin: SupportAdminController;
  jwtVerifier: JwtVerifier;
  rateLimiters: RateLimiters;
  /** `requireIdempotency`, required on ticket open and message post (SU-1, G25). */
  idempotency: RequestHandler;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/** Spec 16 §4.1: customers and sellers, their own tickets; §4.2: admins, every ticket. */
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

  const a = deps.admin;
  const admins = [authenticate(deps.jwtVerifier), requireRole(UserRole.ADMIN)];
  router.get(A.TICKETS, ...admins, a.list);
  router.get(A.TICKET, ...admins, a.get);
  router.get(A.MESSAGES, ...admins, a.messages);
  router.post(A.MESSAGES, ...admins, ...writes, a.post);
  router.post(A.ASSIGN, ...admins, a.assign);
  router.post(A.RESOLVE, ...admins, a.resolve);
  router.post(A.CLOSE, ...admins, a.close);
  router.post(A.READ, ...admins, a.read);

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
  const adminCommon = { tags: ['admin: support'], auth: true } as const;
  const adminTicket = { 200: { description: 'The ticket', body: AdminTicketSummaryDto } };
  docs.add({
    ...adminCommon,
    method: 'get',
    path: `${basePath}${A.TICKETS}`,
    summary:
      'Every ticket, latest activity first. Filters: status[eq|in], category[eq|in], openerRole[eq], assignedAdminId[eq], assigned[eq] (not with assignedAdminId: INVALID_QUERY), slaBreached[eq] (waiting now with the flag), createdAt[gte|lte]. Sort: lastMessageAt (default -lastMessageAt), createdAt, awaitingAdminSince (the oldest-waiting queue: only open / awaiting_admin tickets)',
    query: [
      ...page,
      {
        name: 'sort',
        in: 'query',
        schema: {
          enum: [
            'lastMessageAt',
            '-lastMessageAt',
            'createdAt',
            '-createdAt',
            'awaitingAdminSince',
            '-awaitingAdminSince',
          ],
        },
      },
      { name: 'status[eq]', in: 'query', schema: { enum: Object.values(TicketStatus) } },
      { name: 'status[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'category[eq]', in: 'query', schema: { enum: Object.values(TicketCategory) } },
      { name: 'category[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'openerRole[eq]', in: 'query', schema: { enum: Object.values(TicketOpenerRole) } },
      { name: 'assignedAdminId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'assigned[eq]', in: 'query', schema: { type: 'boolean' } },
      { name: 'slaBreached[eq]', in: 'query', schema: { type: 'boolean' } },
      { name: 'createdAt[gte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'createdAt[lte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
    responses: {
      200: {
        description: 'One page of tickets',
        body: AdminTicketSummaryDto,
        isArray: true,
        paginated: true,
      },
    },
  });
  docs.add({
    ...adminCommon,
    method: 'get',
    path: `${basePath}${A.TICKET}`,
    summary: 'One ticket (SUPPORT_TICKET_NOT_FOUND)',
    responses: adminTicket,
  });
  docs.add({
    ...adminCommon,
    method: 'get',
    path: `${basePath}${A.MESSAGES}`,
    summary: 'The whole timeline, internal notes included, newest first (SUPPORT_TICKET_NOT_FOUND)',
    query: [...page, { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] } }],
    responses: {
      200: { description: 'One page of messages', body: TicketMessageDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...adminCommon,
    method: 'post',
    path: `${basePath}${A.MESSAGES}`,
    summary:
      'Reply to the user, or write an internal note (internal: true; any status, never shown to the user). A reply on an unassigned ticket assigns it to you (SUPPORT_TICKET_NOT_FOUND, SUPPORT_TICKET_CLOSED 409 for replies, MEDIA_NOT_ATTACHABLE 422)',
    idempotent: true,
    requestBody: AdminPostMessageDto,
    responses: { 201: { description: 'The message', body: TicketMessageDto } },
  });
  docs.add({
    ...adminCommon,
    method: 'post',
    path: `${basePath}${A.ASSIGN}`,
    summary:
      'Assign to an active admin, or unassign with null; the current assignee again changes nothing (SUPPORT_TICKET_NOT_FOUND, SUPPORT_ASSIGNEE_INVALID 422, SUPPORT_TICKET_CLOSED 409)',
    requestBody: AssignTicketDto,
    responses: adminTicket,
  });
  docs.add({
    ...adminCommon,
    method: 'post',
    path: `${basePath}${A.RESOLVE}`,
    summary:
      'Mark resolved; the user can reopen it by writing until it is closed automatically (SUPPORT_TICKET_NOT_FOUND, SUPPORT_TICKET_INVALID_STATUS_TRANSITION 409)',
    responses: adminTicket,
  });
  docs.add({
    ...adminCommon,
    method: 'post',
    path: `${basePath}${A.CLOSE}`,
    summary:
      'Close for good, e.g. spam or a duplicate (SUPPORT_TICKET_NOT_FOUND, SUPPORT_TICKET_INVALID_STATUS_TRANSITION 409)',
    responses: adminTicket,
  });
  docs.add({
    ...adminCommon,
    method: 'post',
    path: `${basePath}${A.READ}`,
    summary: 'Mark the ticket read for me (SUPPORT_TICKET_NOT_FOUND)',
    responses: { 204: { description: 'Read' } },
  });
  return router;
}
