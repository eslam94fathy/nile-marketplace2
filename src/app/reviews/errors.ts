import { AppError, internalError, type PgErrorMapper } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';
import { CatalogErrorCode } from '../catalog';

/** reviews error codes (docs/spec/17-reviews.md §6). */
export const ReviewsErrorCode = {
  REVIEW_NOT_FOUND: 'REVIEW_NOT_FOUND',
  REVIEW_NOT_ALLOWED: 'REVIEW_NOT_ALLOWED',
  REVIEW_WINDOW_CLOSED: 'REVIEW_WINDOW_CLOSED',
  REVIEW_ALREADY_EXISTS: 'REVIEW_ALREADY_EXISTS',
  REVIEW_EDIT_WINDOW_CLOSED: 'REVIEW_EDIT_WINDOW_CLOSED',
  REVIEW_HIDDEN: 'REVIEW_HIDDEN',
  REVIEW_ALREADY_REPLIED: 'REVIEW_ALREADY_REPLIED',
  REVIEW_REPLY_NOT_FOUND: 'REVIEW_REPLY_NOT_FOUND',
  REVIEW_INVALID_STATUS_TRANSITION: 'REVIEW_INVALID_STATUS_TRANSITION',
} as const;

const C = ReviewsErrorCode;
const S = HTTP_STATUS;

/** Missing, deleted, or not the caller's: one answer (conventions §3). */
export const reviewNotFound = () => new AppError(C.REVIEW_NOT_FOUND, 'Review not found', S.NOT_FOUND);

export const reviewNotAllowed = () =>
  new AppError(
    C.REVIEW_NOT_ALLOWED,
    'Only a delivered item of yours can be reviewed',
    S.UNPROCESSABLE_ENTITY,
  );

export const reviewWindowClosed = () =>
  new AppError(C.REVIEW_WINDOW_CLOSED, 'The time to review this item has passed', S.UNPROCESSABLE_ENTITY);

export const reviewAlreadyExists = () =>
  new AppError(C.REVIEW_ALREADY_EXISTS, 'You already reviewed this product', S.CONFLICT);

export const reviewEditWindowClosed = () =>
  new AppError(
    C.REVIEW_EDIT_WINDOW_CLOSED,
    'The time to edit this review has passed',
    S.UNPROCESSABLE_ENTITY,
  );

export const reviewHidden = () => new AppError(C.REVIEW_HIDDEN, 'This review is hidden', S.CONFLICT);

export const reviewAlreadyReplied = () =>
  new AppError(C.REVIEW_ALREADY_REPLIED, 'This review already has a reply', S.CONFLICT);

export const reviewReplyNotFound = () =>
  new AppError(C.REVIEW_REPLY_NOT_FOUND, 'This review has no reply', S.NOT_FOUND);

export const reviewInvalidStatusTransition = () =>
  new AppError(
    C.REVIEW_INVALID_STATUS_TRANSITION,
    'This action is not allowed in the current status',
    S.CONFLICT,
  );

/** A customer-role account without its profile: a data defect, 500 (as P4-Q9). */
export const customerProfileMissing = (userId: string) =>
  internalError(new Error(`customer-role user ${userId} has no customer profile`));

/** A seller-role account without its profile: a data defect, 500 (as P4-Q9). */
export const sellerProfileMissing = (userId: string) =>
  internalError(new Error(`seller-role user ${userId} has no seller profile`));

/** UC-RV-1 step 4, UC-RV-3: the constraints decide, there is no pre-check (spec 17). */
export function registerReviewsConstraintErrors(mapper: PgErrorMapper): void {
  mapper.register('uq_product_reviews_customer_id_product_id', reviewAlreadyExists);
  mapper.register('uq_review_replies_review_id', reviewAlreadyReplied);
}

/** The public review endpoints of a product that isn't publicly visible (catalog's code, spec 17 §4.1). */
export const productNotFound = () =>
  new AppError(CatalogErrorCode.PRODUCT_NOT_FOUND, 'Product not found', HTTP_STATUS.NOT_FOUND);
