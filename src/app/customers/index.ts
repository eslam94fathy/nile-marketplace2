/**
 * customers module (docs/spec/04-customers.md): self-registration, profile, delivery addresses.
 * Owns tables: customers, customer_addresses. No other module reads or writes them.
 * May call: identity. This file is its only public surface.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { TOKENS } from '../../lib/di';
import { type PgErrorMapper } from '../../lib/error';
import { type OpenApiRegistry } from '../../lib/http';
import { type RateLimiters } from '../../lib/middleware';
import { CustomerAddressController } from './controller/customer-address.controller';
import { CustomerAdminController } from './controller/customer-admin.controller';
import { CustomerAdminService } from './service/customer-admin.service';
import { CustomerController } from './controller/customer.controller';
import { WishlistController } from './controller/wishlist.controller';
import { registerCustomersConstraintErrors } from './errors';
import { CustomerAddressRepository } from './repository/customer-address.repository';
import { CustomerRepository } from './repository/customer.repository';
import { WishlistRepository } from './repository/wishlist.repository';
import { customersRoutes } from './routes';
import { CustomerAddressService } from './service/customer-address.service';
import { CustomerDirectory } from './service/customer-directory.service';
import { CustomerService } from './service/customer.service';
import { WishlistService } from './service/wishlist.service';

export { CustomersErrorCode } from './errors';
/** Inject with `TOKENS.CustomerDirectory`. */
export type { ICustomerDirectory } from './service/customer-directory.service';
export type { AddressSnapshot } from './model/customer-address.model';

/**
 * The public lookups only (`ICustomerDirectory`), for processes without the customer endpoints
 * (the realtime gateway, the worker). Read-only use: no transaction is started.
 */
export function registerCustomersLookups(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.CustomerRepository, CustomerRepository);
  container.registerSingleton(TOKENS.CustomerAddressRepository, CustomerAddressRepository);
  container.registerSingleton(TOKENS.CustomerAddressService, CustomerAddressService);
  container.registerSingleton(TOKENS.CustomerDirectory, CustomerDirectory);
}

/** api process. Needs identity's AccountService and catalog's directory (the wishlist) registered. */
export function registerCustomersModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.CustomerRepository, CustomerRepository);
  container.registerSingleton(TOKENS.CustomerAddressRepository, CustomerAddressRepository);
  container.registerSingleton(TOKENS.CustomerService, CustomerService);
  container.registerSingleton(TOKENS.CustomerAddressService, CustomerAddressService);
  container.registerSingleton(TOKENS.CustomerDirectory, CustomerDirectory);
  container.registerSingleton(TOKENS.CustomerController, CustomerController);
  container.registerSingleton(TOKENS.CustomerAdminService, CustomerAdminService);
  container.registerSingleton(TOKENS.CustomerAdminController, CustomerAdminController);
  container.registerSingleton(TOKENS.CustomerAddressController, CustomerAddressController);
  container.registerSingleton(TOKENS.WishlistRepository, WishlistRepository);
  container.registerSingleton(TOKENS.WishlistService, WishlistService);
  container.registerSingleton(TOKENS.WishlistController, WishlistController);
  registerCustomersConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createCustomersRouter(container: DependencyContainer, basePath: string): Router {
  return customersRoutes({
    customers: container.resolve<CustomerController>(TOKENS.CustomerController),
    addresses: container.resolve<CustomerAddressController>(TOKENS.CustomerAddressController),
    wishlist: container.resolve<WishlistController>(TOKENS.WishlistController),
    customerAdmin: container.resolve<CustomerAdminController>(TOKENS.CustomerAdminController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    rateLimiters: container.resolve<RateLimiters>(TOKENS.RateLimiters),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
