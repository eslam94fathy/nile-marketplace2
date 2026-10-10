import { type RequestHandler, type Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { CATALOG_SELLER_PATHS as P } from './constants';
import { type SellerProductController } from './controller/seller-product.controller';
import { type SellerVariantController } from './controller/seller-variant.controller';
import {
  CreateProductDto,
  CreateVariantDto,
  StockAdjustmentDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/product-request.dto';
import {
  SellerProductDetailDto,
  SellerProductDto,
  SellerVariantDto,
  StockMovementDto,
  VariantStockDto,
} from './dto/product-response.dto';

const TAGS = ['seller: catalog'] as const;

export interface CatalogSellerRouteDeps {
  products: SellerProductController;
  variants: SellerVariantController;
  jwtVerifier: JwtVerifier;
  /** `requireIdempotency`, for the stock-adjustment route (S-6, G25). */
  idempotency: RequestHandler;
  docs: OpenApiRegistry;
  basePath: string;
}

const page = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
  { name: 'cursor', in: 'query', schema: { type: 'string' } },
] as const;

/** Spec 06 §4.3. Seller role; writes need an approved seller (SELLER_NOT_APPROVED). General rate limit. */
export function addCatalogSellerRoutes(router: Router, deps: CatalogSellerRouteDeps): void {
  const { products, variants, docs, basePath } = deps;
  const sellerOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.SELLER)];

  router.get(P.PRODUCTS, ...sellerOnly, products.list);
  router.post(P.PRODUCTS, ...sellerOnly, products.create);
  router.get(P.PRODUCT, ...sellerOnly, products.get);
  router.patch(P.PRODUCT, ...sellerOnly, products.update);
  router.delete(P.PRODUCT, ...sellerOnly, products.delete);
  router.post(P.ACTIVATE, ...sellerOnly, products.activate);
  router.post(P.DEACTIVATE, ...sellerOnly, products.deactivate);
  router.post(P.VARIANTS, ...sellerOnly, variants.create);
  router.patch(P.VARIANT, ...sellerOnly, variants.update);
  router.delete(P.VARIANT, ...sellerOnly, variants.delete);
  router.post(P.STOCK_ADJUSTMENTS, ...sellerOnly, deps.idempotency, variants.adjustStock);
  router.get(P.STOCK_MOVEMENTS, ...sellerOnly, variants.movements);

  const base = { tags: TAGS, auth: true } as const;
  const detail = (description: string) => ({ description, body: SellerProductDetailDto });
  const path = (p: string) => `${basePath}${p}`;

  docs.add({
    ...base,
    method: 'get',
    path: path(P.PRODUCTS),
    summary:
      'My products (not deleted). Filters: status[eq|in], categoryId[eq], name[like], createdAt[gte|lte]. Sort: createdAt (default -createdAt)',
    query: [
      ...page,
      { name: 'sort', in: 'query', schema: { enum: ['createdAt', '-createdAt'] } },
      { name: 'status[eq]', in: 'query', schema: { type: 'string' } },
      { name: 'status[in]', in: 'query', schema: { type: 'string' }, description: 'comma-separated' },
      { name: 'categoryId[eq]', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'name[like]', in: 'query', schema: { type: 'string' } },
      { name: 'createdAt[gte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'createdAt[lte]', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
    responses: { 200: { description: 'One page', body: SellerProductDto, isArray: true, paginated: true } },
  });
  docs.add({
    ...base,
    method: 'post',
    path: path(P.PRODUCTS),
    summary: 'Create a draft product (SELLER_NOT_APPROVED, CATEGORY_NOT_FOUND)',
    requestBody: CreateProductDto,
    responses: { 201: detail('The new draft product') },
  });
  docs.add({
    ...base,
    method: 'get',
    path: path(P.PRODUCT),
    summary: 'One of my products with its variants and stock (PRODUCT_NOT_FOUND)',
    responses: { 200: detail('The product') },
  });
  docs.add({
    ...base,
    method: 'patch',
    path: path(P.PRODUCT),
    summary:
      'Edit name, description or category; the category only while there are no variants (PRODUCT_NOT_FOUND, SELLER_NOT_APPROVED, CATEGORY_NOT_FOUND, PRODUCT_CATEGORY_LOCKED)',
    requestBody: UpdateProductDto,
    responses: { 200: detail('The product') },
  });
  docs.add({
    ...base,
    method: 'delete',
    path: path(P.PRODUCT),
    summary: 'Delete a product and its variants (PRODUCT_NOT_FOUND, SELLER_NOT_APPROVED)',
    responses: { 204: { description: 'Deleted' } },
  });
  docs.add({
    ...base,
    method: 'post',
    path: path(P.ACTIVATE),
    summary:
      'Publish: draft or inactive → active (PRODUCT_NOT_FOUND, SELLER_NOT_APPROVED, PRODUCT_INVALID_STATUS_TRANSITION, PRODUCT_HAS_NO_ACTIVE_VARIANT)',
    responses: { 200: detail('The product') },
  });
  docs.add({
    ...base,
    method: 'post',
    path: path(P.DEACTIVATE),
    summary:
      'Unpublish: active → inactive (PRODUCT_NOT_FOUND, SELLER_NOT_APPROVED, PRODUCT_INVALID_STATUS_TRANSITION)',
    responses: { 200: detail('The product') },
  });
  docs.add({
    ...base,
    method: 'post',
    path: path(P.VARIANTS),
    summary:
      'Add a variant with its initial stock (PRODUCT_NOT_FOUND, SELLER_NOT_APPROVED, VARIANT_OPTIONS_INVALID, DEFAULT_VARIANT_EXISTS, VARIANT_COMBINATION_EXISTS, SKU_TAKEN, VARIANT_LIMIT_REACHED, COMPARE_AT_PRICE_INVALID)',
    requestBody: CreateVariantDto,
    responses: { 201: { description: 'The new variant', body: SellerVariantDto } },
  });
  docs.add({
    ...base,
    method: 'patch',
    path: path(P.VARIANT),
    summary:
      'Edit SKU, price, compare-at price or status; options are fixed (VARIANT_NOT_FOUND, SELLER_NOT_APPROVED, SKU_TAKEN, COMPARE_AT_PRICE_INVALID)',
    requestBody: UpdateVariantDto,
    responses: { 200: { description: 'The variant', body: SellerVariantDto } },
  });
  docs.add({
    ...base,
    method: 'delete',
    path: path(P.VARIANT),
    summary: 'Delete a variant (VARIANT_NOT_FOUND, SELLER_NOT_APPROVED)',
    responses: { 204: { description: 'Deleted' } },
  });
  docs.add({
    ...base,
    method: 'post',
    path: path(P.STOCK_ADJUSTMENTS),
    summary:
      'Add or remove stock as a delta, never an absolute value (VARIANT_NOT_FOUND, SELLER_NOT_APPROVED, STOCK_ADJUSTMENT_INVALID)',
    idempotent: true,
    requestBody: StockAdjustmentDto,
    responses: { 200: { description: 'Stock after the change', body: VariantStockDto } },
  });
  docs.add({
    ...base,
    method: 'get',
    path: path(P.STOCK_MOVEMENTS),
    summary: 'Stock history of a variant, newest first (VARIANT_NOT_FOUND)',
    query: [...page, { name: 'sort', in: 'query', schema: { enum: ['-createdAt'] } }],
    responses: { 200: { description: 'One page', body: StockMovementDto, isArray: true, paginated: true } },
  });
}
