import { describe, expect, it } from 'vitest';
import { Money } from '../../../lib/money';
import { sha256Hex } from '../../../pkg/crypto';
import { ProductStatus, VariantStatus } from '../enums';
import { computeProjection } from '../model/product-projection';
import { ProductVariant } from '../model/product-variant.model';
import { Product } from '../model/product.model';
import { optionSignature, resolveVariantOptions } from '../model/variant-options';
import { productSlug } from '../service/seller-product.service';

const size = { id: 'a-size', categoryId: 'c', name: 'Size', code: 'size', sortOrder: 0 };
const color = { id: 'a-color', categoryId: 'c', name: 'Color', code: 'color', sortOrder: 1 };
const option = (id: string, attributeId: string) => ({ id, attributeId, value: id, code: id, sortOrder: 0 });
const XL = option('o-xl', 'a-size');
const S = option('o-s', 'a-size');
const RED = option('o-red', 'a-color');
const OTHER = option('o-other', 'a-elsewhere');

describe('resolveVariantOptions (SD-7)', () => {
  it('accepts exactly one option per effective attribute', () => {
    const resolved = resolveVariantOptions([size, color], ['o-red', 'o-xl'], [XL, RED]);
    expect(resolved).toEqual({
      values: [
        { attributeId: 'a-color', optionId: 'o-red' },
        { attributeId: 'a-size', optionId: 'o-xl' },
      ],
      signature: optionSignature(['o-xl', 'o-red']),
    });
  });

  it('the signature ignores order; the default variant signs the empty string', () => {
    expect(optionSignature(['b', 'a'])).toBe(optionSignature(['a', 'b']));
    expect(resolveVariantOptions([], [], [])).toEqual({ values: [], signature: sha256Hex('') });
  });

  it('reports unknown, foreign and duplicate options, then missing attributes', () => {
    const constraints = (ids: string[], found = [XL, S, RED, OTHER]) => {
      const result = resolveVariantOptions([size, color], ids, found);
      return Array.isArray(result) ? result.map((p) => p.constraint) : [];
    };
    expect(constraints(['o-xl', 'nope'])).toEqual(['unknown']);
    expect(constraints(['o-xl', 'o-red', 'o-other'])).toEqual(['not_applicable']);
    expect(constraints(['o-xl', 'o-s', 'o-red'])).toEqual(['one_per_attribute']);
    expect(constraints(['o-xl'])).toEqual(['missing']);
    expect(constraints([])).toEqual(['missing', 'missing']);
  });
});

const variant = (id: string, price: string, status: VariantStatus = VariantStatus.ACTIVE) =>
  new ProductVariant({
    id,
    productId: 'p',
    sellerId: 's',
    sku: id,
    price: Money.of(price),
    compareAtPrice: null,
    status,
    optionSignature: id,
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

describe('computeProjection (spec 06 UC-CA-3/4)', () => {
  it('price range and in-stock over active variants only', () => {
    const projection = computeProjection(
      ProductStatus.ACTIVE,
      [variant('a', '150.00'), variant('b', '99.50'), variant('c', '10.00', VariantStatus.INACTIVE)],
      new Map([
        ['a', 0],
        ['c', 5],
      ]),
    );
    expect(projection.minPrice?.toString()).toBe('99.50');
    expect(projection.maxPrice?.toString()).toBe('150.00');
    expect(projection.inStock).toBe(false); // only the inactive variant has stock
    expect(projection.status).toBe(ProductStatus.ACTIVE);
  });

  it('an active product with no active variant becomes inactive; drafts stay drafts', () => {
    const none = [variant('a', '5.00', VariantStatus.INACTIVE)];
    expect(computeProjection(ProductStatus.ACTIVE, none, new Map())).toEqual({
      minPrice: null,
      maxPrice: null,
      inStock: false,
      status: ProductStatus.INACTIVE,
    });
    expect(computeProjection(ProductStatus.DRAFT, [], new Map()).status).toBe(ProductStatus.DRAFT);
  });
});

describe('product rules', () => {
  it('slugs are kebab(name) plus 6 base36 chars, with a fallback', () => {
    const fixed = () => 10; // "a"
    expect(productSlug('Wireless Headphones!', fixed)).toBe('wireless-headphones-aaaaaa');
    expect(productSlug('!!!', fixed)).toBe('product-aaaaaa');
    expect(productSlug('x'.repeat(300), fixed)).toHaveLength(220);
    expect(productSlug('Phone')).toMatch(/^phone-[0-9a-z]{6}$/);
  });

  it('status transitions: draft → active ⇄ inactive', () => {
    const product = (status: ProductStatus) =>
      new Product({
        id: 'p',
        sellerId: 's',
        categoryId: 'c',
        name: 'n',
        slug: 'n',
        description: 'd',
        status,
        sellerActive: true,
        minPrice: null,
        maxPrice: null,
        inStock: false,
        publishedAt: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    expect(product(ProductStatus.DRAFT).canTransitionTo(ProductStatus.ACTIVE)).toBe(true);
    expect(product(ProductStatus.DRAFT).canTransitionTo(ProductStatus.INACTIVE)).toBe(false);
    expect(product(ProductStatus.ACTIVE).canTransitionTo(ProductStatus.ACTIVE)).toBe(false);
    expect(product(ProductStatus.INACTIVE).canTransitionTo(ProductStatus.ACTIVE)).toBe(true);
    expect(product(ProductStatus.ACTIVE).visible).toBe(true);
  });
});
