import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  type AdminAttributeDto,
  type AdminCategoryNodeDto,
} from '../../src/app/catalog/dto/category-response.dto';
import {
  type SellerProductDetailDto,
  type SellerVariantDto,
} from '../../src/app/catalog/dto/product-response.dto';
import { successBody } from './http';
import { API } from './identity';
import { sellerFixtures } from './sellers';
import { type TestApp } from './test-app';

/** Catalog setup over the real HTTP API (admin taxonomy, approved sellers, products with variants). */
export function catalogApi(t: TestApp, adminToken: string) {
  const send = (
    method: 'get' | 'post' | 'patch' | 'delete',
    token: string | null,
    path: string,
    body?: object,
  ) => {
    const req = request(t.app)[method](`${API}${path}`);
    if (token) void req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const ok = <T>(res: request.Response, status: number): T => {
    if (res.status !== status)
      throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return successBody<T>(res).data;
  };

  async function approvedSeller(): Promise<{ token: string; sellerId: string; userId: string }> {
    const created = await sellerFixtures(t).createVerifiedSeller();
    ok(await send('post', adminToken, `/admin/sellers/${created.sellerId}/approve`), 200);
    return { token: created.accessToken, sellerId: created.sellerId, userId: created.userId };
  }

  async function category(body: Record<string, unknown> = {}): Promise<AdminCategoryNodeDto> {
    const name = `Cat ${randomUUID().slice(0, 8)}`;
    return ok(await send('post', adminToken, '/admin/categories', { name, sortOrder: 0, ...body }), 201);
  }

  /** Adds an attribute with options; returns option ids by option code. */
  async function attribute(
    categoryId: string,
    code: string,
    optionCodes: readonly string[],
    sortOrder = 0,
  ): Promise<Record<string, string>> {
    const created = ok<AdminAttributeDto>(
      await send('post', adminToken, `/admin/categories/${categoryId}/attributes`, {
        name: code,
        code,
        sortOrder,
      }),
      201,
    );
    const ids: Record<string, string> = {};
    for (const [index, optionCode] of optionCodes.entries()) {
      const option = ok<{ id: string }>(
        await send('post', adminToken, `/admin/attributes/${created.id}/options`, {
          value: optionCode.toUpperCase(),
          code: optionCode,
          sortOrder: index,
        }),
        201,
      );
      ids[optionCode] = option.id;
    }
    return ids;
  }

  async function product(
    token: string,
    categoryId: string,
    name: string,
    variants: readonly { optionIds?: string[]; price: string; stock: number; status?: string }[],
    options: { activate?: boolean } = {},
  ): Promise<{ id: string; slug: string; variants: SellerVariantDto[] }> {
    const created = ok<SellerProductDetailDto>(
      await send('post', token, '/seller/products', { categoryId, name, description: `${name} description` }),
      201,
    );
    const made: SellerVariantDto[] = [];
    for (const variant of variants) {
      made.push(
        ok<SellerVariantDto>(
          await send('post', token, `/seller/products/${created.id}/variants`, {
            sku: `SKU-${randomUUID().slice(0, 8)}`,
            price: variant.price,
            optionIds: variant.optionIds ?? [],
            initialStock: variant.stock,
            status: variant.status ?? 'active',
          }),
          201,
        ),
      );
    }
    if (options.activate ?? true)
      ok(await send('post', token, `/seller/products/${created.id}/activate`), 200);
    return { id: created.id, slug: created.slug, variants: made };
  }

  return { send, approvedSeller, category, attribute, product };
}
