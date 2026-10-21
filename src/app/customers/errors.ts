import { AppError, governorateReferenceNotFound, type PgErrorMapper } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';
import { CatalogErrorCode } from '../catalog';

/** customers error codes (docs/spec/04-customers.md §6). GOVERNORATE_NOT_FOUND is common (spec 01 §6). */
export const CustomersErrorCode = {
  ADDRESS_NOT_FOUND: 'ADDRESS_NOT_FOUND',
  ADDRESS_LIMIT_REACHED: 'ADDRESS_LIMIT_REACHED',
  DEFAULT_ADDRESS_UNSET_NOT_ALLOWED: 'DEFAULT_ADDRESS_UNSET_NOT_ALLOWED',
  WISHLIST_LIMIT_REACHED: 'WISHLIST_LIMIT_REACHED',
} as const;

const C = CustomersErrorCode;
const S = HTTP_STATUS;

/** Missing, deleted, or another customer's: the same answer, so ids can't be probed. */
export const addressNotFound = () => new AppError(C.ADDRESS_NOT_FOUND, 'Address not found', S.NOT_FOUND);
export const addressLimitReached = (max: number) =>
  new AppError(C.ADDRESS_LIMIT_REACHED, `You can keep at most ${max} addresses`, S.UNPROCESSABLE_ENTITY);
export const defaultAddressUnsetNotAllowed = () =>
  new AppError(
    C.DEFAULT_ADDRESS_UNSET_NOT_ALLOWED,
    'Set another address as the default instead',
    S.UNPROCESSABLE_ENTITY,
  );

export const wishlistLimitReached = (max: number) =>
  new AppError(C.WISHLIST_LIMIT_REACHED, `You can keep at most ${max} products`, S.UNPROCESSABLE_ENTITY);

/** A product that isn't publicly visible, named in the path of an add: a body-like reference, 422 (spec 04 §8.2). */
export const productNotFound = () =>
  new AppError(CatalogErrorCode.PRODUCT_NOT_FOUND, 'Product not found', S.UNPROCESSABLE_ENTITY);

export function registerCustomersConstraintErrors(mapper: PgErrorMapper): void {
  mapper.register('fk_customer_addresses_governorate_id', governorateReferenceNotFound);
}
