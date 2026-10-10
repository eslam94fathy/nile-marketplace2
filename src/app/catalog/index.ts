/**
 * catalog module (docs/spec/06-catalog.md): the category tree with attributes and options, seller
 * products and variants, public browse and search, and the listing projections.
 * Owns tables: categories, category_attributes, category_attribute_options, products,
 * product_variants, variant_attribute_values. No other module reads or writes them.
 * May call: sellers, inventory. This file is its only public surface.
 */
import { type Router } from 'express';
import { type DependencyContainer } from 'tsyringe';
import { type JwtVerifier } from '../../lib/auth';
import { TOKENS } from '../../lib/di';
import { type PgErrorMapper } from '../../lib/error';
import { type OpenApiRegistry } from '../../lib/http';
import { CategoryAdminController } from './controller/category-admin.controller';
import { CategoryController } from './controller/category.controller';
import { registerCatalogConstraintErrors } from './errors';
import { CategoryAttributeOptionRepository } from './repository/category-attribute-option.repository';
import { CategoryAttributeRepository } from './repository/category-attribute.repository';
import { CategoryRepository } from './repository/category.repository';
import { ProductRepository } from './repository/product.repository';
import { VariantAttributeValueRepository } from './repository/variant-attribute-value.repository';
import { catalogRoutes } from './routes';
import { CategoryAdminService } from './service/category-admin.service';
import { CategoryTreeService } from './service/category-tree.service';
import { CategoryService } from './service/category.service';

export { ProductStatus, VariantStatus } from './enums';
export { CatalogErrorCode } from './errors';

/** api process. */
export function registerCatalogModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.CategoryRepository, CategoryRepository);
  container.registerSingleton(TOKENS.CategoryAttributeRepository, CategoryAttributeRepository);
  container.registerSingleton(TOKENS.CategoryAttributeOptionRepository, CategoryAttributeOptionRepository);
  container.registerSingleton(TOKENS.ProductRepository, ProductRepository);
  container.registerSingleton(TOKENS.VariantAttributeValueRepository, VariantAttributeValueRepository);
  container.registerSingleton(TOKENS.CategoryTreeService, CategoryTreeService);
  container.registerSingleton(TOKENS.CategoryService, CategoryService);
  container.registerSingleton(TOKENS.CategoryAdminService, CategoryAdminService);
  container.registerSingleton(TOKENS.CategoryController, CategoryController);
  container.registerSingleton(TOKENS.CategoryAdminController, CategoryAdminController);
  registerCatalogConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createCatalogRouter(container: DependencyContainer, basePath: string): Router {
  return catalogRoutes({
    categories: container.resolve<CategoryController>(TOKENS.CategoryController),
    categoryAdmin: container.resolve<CategoryAdminController>(TOKENS.CategoryAdminController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
