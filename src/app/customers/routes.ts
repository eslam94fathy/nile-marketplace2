import { Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import {
  authenticate,
  byIpAndEmail,
  RateLimitClass,
  type RateLimiters,
  requireRole,
} from '../../lib/middleware';
import { type WishlistController } from './controller/wishlist.controller';
import { WishlistItemDto, WishlistProductIdsDto } from './dto/wishlist.dto';
import { CUSTOMERS_ADMIN_PATHS as A, CUSTOMERS_PATHS as P } from './constants';
import { type CustomerAdminController } from './controller/customer-admin.controller';
import { type CustomerAddressController } from './controller/customer-address.controller';
import { type CustomerController } from './controller/customer.controller';
import {
  CreateAddressDto,
  RegisterCustomerDto,
  UpdateAddressDto,
  UpdateCustomerProfileDto,
} from './dto/customer-request.dto';
import {
  AddressDto,
  AdminCustomerDetailDto,
  AdminCustomerDto,
  CustomerProfileDto,
  RegisteredCustomerDto,
} from './dto/customer-response.dto';

const AUTH_TAGS = ['auth'] as const;
const TAGS = ['customer'] as const;

export interface CustomersRouteDeps {
  customers: CustomerController;
  addresses: CustomerAddressController;
  wishlist: WishlistController;
  customerAdmin: CustomerAdminController;
  jwtVerifier: JwtVerifier;
  rateLimiters: RateLimiters;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/** Spec 04 §4. Registration is strict-auth; the rest uses the global general limit. */
export function customersRoutes(deps: CustomersRouteDeps): Router {
  const { customers, addresses, docs, basePath } = deps;
  const router = Router();
  const customerOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.CUSTOMER)];

  router.post(
    P.REGISTER,
    deps.rateLimiters.limit(RateLimitClass.STRICT_AUTH, byIpAndEmail),
    customers.register,
  );
  router.get(P.ME, ...customerOnly, customers.getProfile);
  router.patch(P.ME, ...customerOnly, customers.updateProfile);
  router.get(P.ADDRESSES, ...customerOnly, addresses.list);
  router.post(P.ADDRESSES, ...customerOnly, addresses.create);
  router.get(P.ADDRESS, ...customerOnly, addresses.get);
  router.patch(P.ADDRESS, ...customerOnly, addresses.update);
  router.delete(P.ADDRESS, ...customerOnly, addresses.delete);
  // `product-ids` before `:productId`.
  router.get(P.WISHLIST_PRODUCT_IDS, ...customerOnly, deps.wishlist.productIds);
  router.get(P.WISHLIST, ...customerOnly, deps.wishlist.list);
  router.put(P.WISHLIST_ITEM, ...customerOnly, deps.wishlist.add);
  router.delete(P.WISHLIST_ITEM, ...customerOnly, deps.wishlist.remove);
  const adminOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.ADMIN)];
  router.get(A.CUSTOMERS, ...adminOnly, deps.customerAdmin.list);
  router.get(A.CUSTOMER, ...adminOnly, deps.customerAdmin.get);

  const adminDocs = { tags: ['admin: customers'], auth: true } as const;
  docs.add({
    ...adminDocs,
    method: 'get',
    path: `${basePath}${A.CUSTOMERS}`,
    summary:
      'List customers (spec 20 §3.3). Filters: name[like] (first or last name, contains), phone[eq] (E.164). Sort: createdAt (default -createdAt)',
    query: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] } },
      { name: 'name[like]', in: 'query', schema: { type: 'string' } },
      { name: 'phone[eq]', in: 'query', schema: { type: 'string' } },
    ],
    responses: {
      200: { description: 'One page of customers', body: AdminCustomerDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...adminDocs,
    method: 'get',
    path: `${basePath}${A.CUSTOMER}`,
    summary:
      'One customer with the address count; their orders come from GET /admin/orders?customerId[eq]= (CUSTOMER_NOT_FOUND)',
    responses: { 200: { description: 'The customer', body: AdminCustomerDetailDto } },
  });

  const wishlistDocs = { tags: ['customer: wishlist'], auth: true } as const;
  docs.add({
    ...wishlistDocs,
    method: 'get',
    path: `${basePath}${P.WISHLIST}`,
    summary: 'My wishlist, newest first; products no longer visible stay, with available: false',
    query: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
    ],
    responses: {
      200: { description: 'One page of products', body: WishlistItemDto, isArray: true, paginated: true },
    },
  });
  docs.add({
    ...wishlistDocs,
    method: 'get',
    path: `${basePath}${P.WISHLIST_PRODUCT_IDS}`,
    summary: 'Every wishlisted product id, to mark product lists (load once per session)',
    responses: { 200: { description: 'The ids', body: WishlistProductIdsDto } },
  });
  docs.add({
    ...wishlistDocs,
    method: 'put',
    path: `${basePath}${P.WISHLIST_ITEM}`,
    summary:
      'Add a visible product; adding it again changes nothing (PRODUCT_NOT_FOUND 422, WISHLIST_LIMIT_REACHED 422)',
    responses: { 204: { description: 'In the wishlist' } },
  });
  docs.add({
    ...wishlistDocs,
    method: 'delete',
    path: `${basePath}${P.WISHLIST_ITEM}`,
    summary: 'Remove a product; removing one that is not there is fine',
    responses: { 204: { description: 'Not in the wishlist' } },
  });

  docs.add({
    method: 'post',
    path: `${basePath}${P.REGISTER}`,
    summary:
      'Register as a customer; a verification OTP is emailed and no tokens are issued until it is verified (EMAIL_ALREADY_REGISTERED)',
    tags: AUTH_TAGS,
    auth: false,
    requestBody: RegisterCustomerDto,
    responses: { 201: { description: 'The pending account', body: RegisteredCustomerDto } },
  });

  const mine = { tags: TAGS, auth: true } as const;
  const profile = { 200: { description: 'My profile', body: CustomerProfileDto } };
  const address = { 200: { description: 'The address', body: AddressDto } };
  docs.add({ ...mine, method: 'get', path: `${basePath}${P.ME}`, summary: 'My profile', responses: profile });
  docs.add({
    ...mine,
    method: 'patch',
    path: `${basePath}${P.ME}`,
    summary: 'Update my name or phone (the email cannot be changed)',
    requestBody: UpdateCustomerProfileDto,
    responses: profile,
  });
  docs.add({
    ...mine,
    method: 'get',
    path: `${basePath}${P.ADDRESSES}`,
    summary: 'My addresses: the default first, then newest first',
    responses: { 200: { description: 'My addresses', body: AddressDto, isArray: true } },
  });
  docs.add({
    ...mine,
    method: 'post',
    path: `${basePath}${P.ADDRESSES}`,
    summary:
      'Add an address; it becomes the default when asked or when there is none (ADDRESS_LIMIT_REACHED, GOVERNORATE_NOT_FOUND)',
    requestBody: CreateAddressDto,
    responses: { 201: { description: 'The new address', body: AddressDto } },
  });
  docs.add({
    ...mine,
    method: 'get',
    path: `${basePath}${P.ADDRESS}`,
    summary: 'One of my addresses (ADDRESS_NOT_FOUND)',
    responses: address,
  });
  docs.add({
    ...mine,
    method: 'patch',
    path: `${basePath}${P.ADDRESS}`,
    summary:
      'Edit an address; isDefault=true moves the default here (ADDRESS_NOT_FOUND, GOVERNORATE_NOT_FOUND, DEFAULT_ADDRESS_UNSET_NOT_ALLOWED)',
    requestBody: UpdateAddressDto,
    responses: address,
  });
  docs.add({
    ...mine,
    method: 'delete',
    path: `${basePath}${P.ADDRESS}`,
    summary: 'Delete an address; deleting the default leaves no default (ADDRESS_NOT_FOUND)',
    responses: { 204: { description: 'Deleted' } },
  });

  return router;
}
