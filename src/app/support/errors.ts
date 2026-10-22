import { AppError, internalError } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';
import { OrderingErrorCode } from '../ordering';

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

/** A missing or foreign order link: a body reference, so 422 (spec 16 §6, conventions §3). */
export const orderLinkNotFound = () =>
  new AppError(OrderingErrorCode.ORDER_NOT_FOUND, 'Order not found', HTTP_STATUS.UNPROCESSABLE_ENTITY);

export const sellerOrderLinkNotFound = () =>
  new AppError(
    OrderingErrorCode.SELLER_ORDER_NOT_FOUND,
    'Seller order not found',
    HTTP_STATUS.UNPROCESSABLE_ENTITY,
  );

/** A customer- or seller-role account without its profile: a data defect, 500 (SU-9, as P4-Q9). */
export const openerProfileMissing = (role: string, userId: string) =>
  internalError(new Error(`${role}-role user ${userId} has no ${role} profile`));
