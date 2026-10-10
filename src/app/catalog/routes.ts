import { type RequestHandler, Router } from 'express';
import { type JwtVerifier, UserRole } from '../../lib/auth';
import { type OpenApiRegistry } from '../../lib/http';
import { authenticate, requireRole } from '../../lib/middleware';
import { CATALOG_ADMIN_PATHS as A, CATALOG_PATHS as P } from './constants';
import { type CategoryAdminController } from './controller/category-admin.controller';
import { type CategoryController } from './controller/category.controller';
import { type SellerProductController } from './controller/seller-product.controller';
import { type SellerVariantController } from './controller/seller-variant.controller';
import { addCatalogSellerRoutes } from './seller-routes';
import {
  CreateAttributeDto,
  CreateCategoryDto,
  CreateOptionDto,
  UpdateAttributeDto,
  UpdateCategoryDto,
  UpdateOptionDto,
} from './dto/category-request.dto';
import {
  AdminAttributeDto,
  AdminCategoryNodeDto,
  AttributeOptionDto,
  CategoryNodeDto,
  EffectiveAttributeDto,
} from './dto/category-response.dto';

const TAGS = ['catalog'] as const;
const ADMIN_TAGS = ['admin: catalog'] as const;

export interface CatalogRouteDeps {
  categories: CategoryController;
  categoryAdmin: CategoryAdminController;
  sellerProducts: SellerProductController;
  sellerVariants: SellerVariantController;
  jwtVerifier: JwtVerifier;
  idempotency: RequestHandler;
  docs: OpenApiRegistry;
  /** Where the router is mounted (`/api/v1`), for the documented paths. */
  basePath: string;
}

/** Spec 06 §4.1 (public), §4.2 (admin) and §4.3 (seller). General rate limit (global). */
export function catalogRoutes(deps: CatalogRouteDeps): Router {
  const { categories, categoryAdmin: admin, docs, basePath } = deps;
  const router = Router();
  const adminOnly = [authenticate(deps.jwtVerifier), requireRole(UserRole.ADMIN)];

  router.get(P.CATEGORIES, categories.tree);
  router.get(P.CATEGORY_ATTRIBUTES, categories.attributes);

  router.get(A.CATEGORIES, ...adminOnly, admin.tree);
  router.post(A.CATEGORIES, ...adminOnly, admin.createCategory);
  router.patch(A.CATEGORY, ...adminOnly, admin.updateCategory);
  router.post(A.CATEGORY_ATTRIBUTES, ...adminOnly, admin.addAttribute);
  router.patch(A.ATTRIBUTE, ...adminOnly, admin.updateAttribute);
  router.delete(A.ATTRIBUTE, ...adminOnly, admin.deleteAttribute);
  router.post(A.ATTRIBUTE_OPTIONS, ...adminOnly, admin.addOption);
  router.patch(A.OPTION, ...adminOnly, admin.updateOption);
  router.delete(A.OPTION, ...adminOnly, admin.deleteOption);

  addCatalogSellerRoutes(router, {
    products: deps.sellerProducts,
    variants: deps.sellerVariants,
    jwtVerifier: deps.jwtVerifier,
    idempotency: deps.idempotency,
    docs,
    basePath,
  });

  docs.add({
    method: 'get',
    path: `${basePath}${P.CATEGORIES}`,
    summary: 'The active category tree',
    tags: TAGS,
    auth: false,
    responses: {
      200: { description: 'Root categories with nested children', body: CategoryNodeDto, isArray: true },
    },
  });
  docs.add({
    method: 'get',
    path: `${basePath}${P.CATEGORY_ATTRIBUTES}`,
    summary: 'Attributes of a category, inherited ones included (CATEGORY_NOT_FOUND)',
    tags: TAGS,
    auth: false,
    responses: {
      200: { description: 'Ancestors first, then sortOrder', body: EffectiveAttributeDto, isArray: true },
    },
  });

  const adminDoc = { tags: ADMIN_TAGS, auth: true } as const;
  const node = (description: string) => ({ description, body: AdminCategoryNodeDto });
  docs.add({
    ...adminDoc,
    method: 'get',
    path: `${basePath}${A.CATEGORIES}`,
    summary: 'The whole category tree, inactive categories and own attributes included',
    responses: { 200: { ...node('Root categories with nested children'), isArray: true } },
  });
  docs.add({
    ...adminDoc,
    method: 'post',
    path: `${basePath}${A.CATEGORIES}`,
    summary:
      'Create a category (CATEGORY_NOT_FOUND, CATEGORY_PARENT_INACTIVE, CATEGORY_MAX_DEPTH_EXCEEDED, CATEGORY_NAME_TAKEN, CATEGORY_SLUG_TAKEN, CATEGORY_SLUG_REQUIRED, CATEGORY_CHILD_LIMIT_REACHED)',
    requestBody: CreateCategoryDto,
    responses: { 201: node('The new category') },
  });
  docs.add({
    ...adminDoc,
    method: 'patch',
    path: `${basePath}${A.CATEGORY}`,
    summary:
      'Rename, re-slug, reorder, activate or deactivate (CATEGORY_NOT_FOUND, CATEGORY_NAME_TAKEN, CATEGORY_SLUG_TAKEN, CATEGORY_IN_USE, CATEGORY_PARENT_INACTIVE)',
    requestBody: UpdateCategoryDto,
    responses: { 200: node('The category with its subtree') },
  });
  docs.add({
    ...adminDoc,
    method: 'post',
    path: `${basePath}${A.CATEGORY_ATTRIBUTES}`,
    summary:
      'Add an attribute (CATEGORY_NOT_FOUND, ATTRIBUTE_CODE_CONFLICT, CATEGORY_HAS_PRODUCTS, ATTRIBUTE_LIMIT_REACHED)',
    requestBody: CreateAttributeDto,
    responses: { 201: { description: 'The new attribute', body: AdminAttributeDto } },
  });
  docs.add({
    ...adminDoc,
    method: 'patch',
    path: `${basePath}${A.ATTRIBUTE}`,
    summary: 'Rename or reorder an attribute; its code is immutable (ATTRIBUTE_NOT_FOUND)',
    requestBody: UpdateAttributeDto,
    responses: { 200: { description: 'The attribute', body: AdminAttributeDto } },
  });
  docs.add({
    ...adminDoc,
    method: 'delete',
    path: `${basePath}${A.ATTRIBUTE}`,
    summary: 'Delete an attribute and its options (ATTRIBUTE_NOT_FOUND, ATTRIBUTE_IN_USE)',
    responses: { 204: { description: 'Deleted' } },
  });
  docs.add({
    ...adminDoc,
    method: 'post',
    path: `${basePath}${A.ATTRIBUTE_OPTIONS}`,
    summary: 'Add an option (ATTRIBUTE_NOT_FOUND, OPTION_CODE_TAKEN, OPTION_LIMIT_REACHED)',
    requestBody: CreateOptionDto,
    responses: { 201: { description: 'The new option', body: AttributeOptionDto } },
  });
  docs.add({
    ...adminDoc,
    method: 'patch',
    path: `${basePath}${A.OPTION}`,
    summary: 'Change the display value or the order of an option (OPTION_NOT_FOUND)',
    requestBody: UpdateOptionDto,
    responses: { 200: { description: 'The option', body: AttributeOptionDto } },
  });
  docs.add({
    ...adminDoc,
    method: 'delete',
    path: `${basePath}${A.OPTION}`,
    summary: 'Delete an option no variant uses (OPTION_NOT_FOUND, OPTION_IN_USE)',
    responses: { 204: { description: 'Deleted' } },
  });

  return router;
}
