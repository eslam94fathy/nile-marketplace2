import { AppError } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** support error codes (docs/spec/16-support.md §6). ORDER_NOT_FOUND / SELLER_ORDER_NOT_FOUND belong to ordering. */
export const SupportErrorCode = {
  SUPPORT_TICKET_NOT_FOUND: 'SUPPORT_TICKET_NOT_FOUND',
  SUPPORT_TICKET_CLOSED: 'SUPPORT_TICKET_CLOSED',
  SUPPORT_TICKET_INVALID_STATUS_TRANSITION: 'SUPPORT_TICKET_INVALID_STATUS_TRANSITION',
  SUPPORT_CATEGORY_NOT_ALLOWED: 'SUPPORT_CATEGORY_NOT_ALLOWED',
  SUPPORT_OPEN_TICKET_LIMIT_REACHED: 'SUPPORT_OPEN_TICKET_LIMIT_REACHED',
  SUPPORT_ASSIGNEE_INVALID: 'SUPPORT_ASSIGNEE_INVALID',
} as const;

/** Missing, or not the caller's ticket: one answer for both (conventions §3). */
export const supportTicketNotFound = () =>
  new AppError(SupportErrorCode.SUPPORT_TICKET_NOT_FOUND, 'Ticket not found', HTTP_STATUS.NOT_FOUND);

export const supportTicketClosed = () =>
  new AppError(
    SupportErrorCode.SUPPORT_TICKET_CLOSED,
    'This ticket is closed; open a new one',
    HTTP_STATUS.CONFLICT,
  );

export const supportTicketInvalidStatusTransition = () =>
  new AppError(
    SupportErrorCode.SUPPORT_TICKET_INVALID_STATUS_TRANSITION,
    'This action is not allowed in the ticket status',
    HTTP_STATUS.CONFLICT,
  );

export const supportCategoryNotAllowed = () =>
  new AppError(
    SupportErrorCode.SUPPORT_CATEGORY_NOT_ALLOWED,
    'This category is not available for your account',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
  );

export const supportOpenTicketLimitReached = () =>
  new AppError(
    SupportErrorCode.SUPPORT_OPEN_TICKET_LIMIT_REACHED,
    'Too many open tickets',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
  );

export const supportAssigneeInvalid = () =>
  new AppError(
    SupportErrorCode.SUPPORT_ASSIGNEE_INVALID,
    'The assignee is not an active admin',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
  );
