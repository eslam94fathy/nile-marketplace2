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
import { CustomerController } from './controller/customer.controller';
import { registerCustomersConstraintErrors } from './errors';
import { CustomerAddressRepository } from './repository/customer-address.repository';
import { CustomerRepository } from './repository/customer.repository';
import { customersRoutes } from './routes';
import { CustomerAddressService } from './service/customer-address.service';
import { CustomerDirectory } from './service/customer-directory.service';
import { CustomerService } from './service/customer.service';

export { CustomersErrorCode } from './errors';
/** Inject with `TOKENS.CustomerDirectory`. */
export type { ICustomerDirectory } from './service/customer-directory.service';
export type { AddressSnapshot } from './model/customer-address.model';

/** api process. Needs identity's AccountService registered first. */
export function registerCustomersModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.CustomerRepository, CustomerRepository);
  container.registerSingleton(TOKENS.CustomerAddressRepository, CustomerAddressRepository);
  container.registerSingleton(TOKENS.CustomerService, CustomerService);
  container.registerSingleton(TOKENS.CustomerAddressService, CustomerAddressService);
  container.registerSingleton(TOKENS.CustomerDirectory, CustomerDirectory);
  container.registerSingleton(TOKENS.CustomerController, CustomerController);
  container.registerSingleton(TOKENS.CustomerAddressController, CustomerAddressController);
  registerCustomersConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createCustomersRouter(container: DependencyContainer, basePath: string): Router {
  return customersRoutes({
    customers: container.resolve<CustomerController>(TOKENS.CustomerController),
    addresses: container.resolve<CustomerAddressController>(TOKENS.CustomerAddressController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    rateLimiters: container.resolve<RateLimiters>(TOKENS.RateLimiters),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
