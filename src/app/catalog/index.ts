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
import { type ApiEnv } from '../../lib/config';
import { TOKENS } from '../../lib/di';
import { type PgErrorMapper } from '../../lib/error';
import {
  type EventEnvelope,
  type EventHandlerDefinition,
  InventoryStockStatusChanged,
  PermanentEventError,
  SellerApproved,
  SellerSuspended,
} from '../../lib/events';
import { type OpenApiRegistry } from '../../lib/http';
import { type ILogger } from '../../lib/logger';
import { requireIdempotency } from '../../lib/middleware';
import { type ICache } from '../../pkg/cache';
import { CategoryAdminController } from './controller/category-admin.controller';
import { CategoryController } from './controller/category.controller';
import { ProductController } from './controller/product.controller';
import { SellerProductController } from './controller/seller-product.controller';
import { SellerVariantController } from './controller/seller-variant.controller';
import { CATALOG_LISTING_PROJECTIONS_QUEUE } from './constants';
import { registerCatalogConstraintErrors } from './errors';
import { CategoryAttributeOptionRepository } from './repository/category-attribute-option.repository';
import { CategoryAttributeRepository } from './repository/category-attribute.repository';
import { CategoryRepository } from './repository/category.repository';
import { ProductVariantRepository } from './repository/product-variant.repository';
import { ProductRepository } from './repository/product.repository';
import { VariantAttributeValueRepository } from './repository/variant-attribute-value.repository';
import { catalogRoutes } from './routes';
import { CatalogDirectory } from './service/catalog-directory.service';
import { CategoryAdminService } from './service/category-admin.service';
import { CategoryTreeService } from './service/category-tree.service';
import { CategoryService } from './service/category.service';
import { ListingProjectionService } from './service/listing-projection.service';
import { ProductBrowseService } from './service/product-browse.service';
import { ProductDetailCache } from './service/product-detail-cache.service';
import { ProductProjectionService } from './service/product-projection.service';
import { SellerGuard } from './service/seller-guard.service';
import { SellerProductService } from './service/seller-product.service';
import { SellerVariantService } from './service/seller-variant.service';
import { VariantViewService } from './service/variant-view.service';

export { ProductStatus, VariantStatus } from './enums';
export { CatalogErrorCode } from './errors';
export type { PurchasableVariant } from './model/purchasable-variant.model';
/** Inject with `TOKENS.CatalogDirectory`. */
export type { ICatalogDirectory } from './service/catalog-directory.service';

/** api process. Needs sellers' SellerDirectory and inventory's InventoryService registered first. */
export function registerCatalogModule(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.CategoryRepository, CategoryRepository);
  container.registerSingleton(TOKENS.CategoryAttributeRepository, CategoryAttributeRepository);
  container.registerSingleton(TOKENS.CategoryAttributeOptionRepository, CategoryAttributeOptionRepository);
  container.registerSingleton(TOKENS.ProductRepository, ProductRepository);
  container.registerSingleton(TOKENS.ProductVariantRepository, ProductVariantRepository);
  container.registerSingleton(TOKENS.VariantAttributeValueRepository, VariantAttributeValueRepository);
  container.registerSingleton(TOKENS.CategoryTreeService, CategoryTreeService);
  container.registerSingleton(TOKENS.CategoryService, CategoryService);
  container.registerSingleton(TOKENS.CategoryAdminService, CategoryAdminService);
  container.registerSingleton(TOKENS.SellerGuard, SellerGuard);
  container.registerSingleton(TOKENS.VariantViewService, VariantViewService);
  container.registerSingleton(TOKENS.ProductProjectionService, ProductProjectionService);
  container.registerSingleton(TOKENS.SellerProductService, SellerProductService);
  container.registerSingleton(TOKENS.SellerVariantService, SellerVariantService);
  container.registerSingleton(TOKENS.ProductDetailCache, ProductDetailCache);
  container.registerSingleton(TOKENS.ProductBrowseService, ProductBrowseService);
  container.registerSingleton(TOKENS.CatalogDirectory, CatalogDirectory);
  container.registerSingleton(TOKENS.CategoryController, CategoryController);
  container.registerSingleton(TOKENS.CategoryAdminController, CategoryAdminController);
  container.registerSingleton(TOKENS.SellerProductController, SellerProductController);
  container.registerSingleton(TOKENS.SellerVariantController, SellerVariantController);
  container.registerSingleton(TOKENS.ProductController, ProductController);
  registerCatalogConstraintErrors(container.resolve<PgErrorMapper>(TOKENS.PgErrorMapper));
}

/**
 * worker process: what the listing-projection consumer needs (no HTTP, no cache). Needs sellers'
 * SellerDirectory and inventory's InventoryService registered first.
 */
export function registerCatalogProjections(container: DependencyContainer): void {
  container.registerSingleton(TOKENS.ProductRepository, ProductRepository);
  container.registerSingleton(TOKENS.ProductVariantRepository, ProductVariantRepository);
  container.registerSingleton(TOKENS.ProductProjectionService, ProductProjectionService);
  container.registerSingleton(TOKENS.ListingProjectionService, ListingProjectionService);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A payload that can never be processed goes straight to the DLQ (retries can't fix it). */
function uuidField(envelope: EventEnvelope, field: string): string {
  const value = envelope.payload[field];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new PermanentEventError(`${envelope.eventType}: payload.${field} must be a UUID`);
  }
  return value;
}

/** Consumer `catalog.listing-projections` (spec 06 UC-CA-7, spec 02 §2). */
export function createCatalogHandlers(container: DependencyContainer): EventHandlerDefinition[] {
  const projections = container.resolve<ListingProjectionService>(TOKENS.ListingProjectionService);
  return [
    {
      name: CATALOG_LISTING_PROJECTIONS_QUEUE,
      events: [SellerApproved, SellerSuspended, InventoryStockStatusChanged],
      handle: (envelope, trx) =>
        envelope.eventType === InventoryStockStatusChanged.type
          ? projections.syncStock(uuidField(envelope, 'variantId'), trx)
          : projections.syncSeller(uuidField(envelope, 'sellerId'), trx),
    },
  ];
}

/** The module's HTTP routes, mounted by the composition root at `basePath` (`/api/v1`). */
export function createCatalogRouter(container: DependencyContainer, basePath: string): Router {
  return catalogRoutes({
    categories: container.resolve<CategoryController>(TOKENS.CategoryController),
    categoryAdmin: container.resolve<CategoryAdminController>(TOKENS.CategoryAdminController),
    products: container.resolve<ProductController>(TOKENS.ProductController),
    sellerProducts: container.resolve<SellerProductController>(TOKENS.SellerProductController),
    sellerVariants: container.resolve<SellerVariantController>(TOKENS.SellerVariantController),
    jwtVerifier: container.resolve<JwtVerifier>(TOKENS.JwtVerifier),
    idempotency: requireIdempotency(
      container.resolve<ICache>(TOKENS.Cache),
      container.resolve<ApiEnv>(TOKENS.Env),
      container.resolve<ILogger>(TOKENS.Logger),
    ),
    docs: container.resolve<OpenApiRegistry>(TOKENS.OpenApiRegistry),
    basePath,
  });
}
