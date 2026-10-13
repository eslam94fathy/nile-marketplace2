import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import { CATALOG_TABLES } from '../constants';
import { ProductStatus, VariantStatus } from '../enums';
import { ProductVariant } from '../model/product-variant.model';
import { type PurchasableVariant } from '../model/purchasable-variant.model';

const T = CATALOG_TABLES.PRODUCT_VARIANTS;
const PRODUCTS = CATALOG_TABLES.PRODUCTS;
const VALUES = CATALOG_TABLES.VARIANT_ATTRIBUTE_VALUES;
const ATTRIBUTES = CATALOG_TABLES.CATEGORY_ATTRIBUTES;
const OPTIONS = CATALOG_TABLES.CATEGORY_ATTRIBUTE_OPTIONS;
const CATEGORIES = CATALOG_TABLES.CATEGORIES;

interface PurchaseRow {
  variant_id: string;
  product_id: string;
  product_name: string;
  product_slug: string;
  sku: string;
  /** NUMERIC as a string. */
  price: string;
  seller_id: string;
  purchasable: boolean;
  attributes: { attribute: string; value: string }[];
}
const COLUMNS = [
  'id',
  'product_id',
  'seller_id',
  'sku',
  'price',
  'compare_at_price',
  'status',
  'option_signature',
  'is_default',
  'created_at',
  'updated_at',
] as const;

interface ProductVariantTable {
  id: string;
  product_id: string;
  seller_id: string;
  sku: string;
  /** NUMERIC comes back from pg as a string. */
  price: string;
  compare_at_price: string | null;
  status: VariantStatus;
  option_signature: string;
  is_default: boolean;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type VariantRow = Pick<ProductVariantTable, (typeof COLUMNS)[number]>;

export interface NewProductVariant {
  productId: string;
  sellerId: string;
  sku: string;
  price: Money;
  compareAtPrice: Money | null;
  status: VariantStatus;
  optionSignature: string;
  isDefault: boolean;
}

export interface ProductVariantPatch {
  sku?: string;
  price?: Money;
  compareAtPrice?: Money | null;
  status?: VariantStatus;
}

function toModel(row: VariantRow): ProductVariant {
  return new ProductVariant({
    id: row.id,
    productId: row.product_id,
    sellerId: row.seller_id,
    sku: row.sku,
    price: Money.of(row.price),
    compareAtPrice: row.compare_at_price === null ? null : Money.of(row.compare_at_price),
    status: row.status,
    optionSignature: row.option_signature,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

@injectable()
export class ProductVariantRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async insert(variant: NewProductVariant, trx: DbTransaction): Promise<ProductVariant> {
    const [row] = await trx<ProductVariantTable>(T)
      .insert({
        product_id: variant.productId,
        seller_id: variant.sellerId,
        sku: variant.sku,
        price: variant.price.toString(),
        compare_at_price: variant.compareAtPrice?.toString() ?? null,
        status: variant.status,
        option_signature: variant.optionSignature,
        is_default: variant.isDefault,
      })
      .returning<VariantRow[]>(COLUMNS);
    if (!row) throw new Error('product_variants insert returned no row');
    return toModel(row);
  }

  /** Live variants of these products, oldest first (idx_product_variants_product_id). */
  async findLiveByProductIds(productIds: readonly string[], trx?: DbTransaction): Promise<ProductVariant[]> {
    if (productIds.length === 0) return [];
    const rows = await this.exec(trx)<ProductVariantTable>(T)
      .select(...COLUMNS)
      .whereIn('product_id', [...new Set(productIds)])
      .whereNull('deleted_at')
      .orderBy([
        { column: 'created_at', order: 'asc' },
        { column: 'id', order: 'asc' },
      ]);
    return rows.map(toModel);
  }

  /** A live variant of this seller (variants are deleted with their product, so its product is live too). */
  /** The product of a variant, deleted variants included (event consumers). */
  async findProductIdOf(variantId: string, trx: DbTransaction): Promise<string | null> {
    const row = await trx<ProductVariantTable>(T)
      .select('product_id')
      .where({ id: variantId })
      .first<Pick<ProductVariantTable, 'product_id'> | undefined>();
    return row?.product_id ?? null;
  }

  async findLiveForSeller(id: string, sellerId: string, trx?: DbTransaction): Promise<ProductVariant | null> {
    const row = await this.exec(trx)<ProductVariantTable>(T)
      .select(...COLUMNS)
      .where({ id, seller_id: sellerId })
      .whereNull('deleted_at')
      .first<VariantRow | undefined>();
    return row ? toModel(row) : null;
  }

  async update(id: string, patch: ProductVariantPatch, trx: DbTransaction): Promise<ProductVariant> {
    const [row] = await trx<ProductVariantTable>(T)
      .where({ id })
      .update({
        ...(patch.sku !== undefined && { sku: patch.sku }),
        ...(patch.price !== undefined && { price: patch.price.toString() }),
        ...(patch.compareAtPrice !== undefined && {
          compare_at_price: patch.compareAtPrice?.toString() ?? null,
        }),
        ...(patch.status !== undefined && { status: patch.status }),
        updated_at: trx.fn.now(),
      })
      .returning<VariantRow[]>(COLUMNS);
    if (!row) throw new Error(`product_variants ${id} vanished under the product lock`);
    return toModel(row);
  }

  async softDelete(id: string, trx: DbTransaction): Promise<void> {
    await trx<ProductVariantTable>(T).where({ id }).whereNull('deleted_at').update({
      deleted_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });
  }

  /**
   * What cart and ordering need, in one query (spec 06 §2): each variant with its product, its
   * options (depth, then sort order) and `purchasable`. Deleted variants are included (not
   * purchasable); unknown ids are left out. Joins stay inside catalog's own tables.
   */
  async findForPurchase(variantIds: readonly string[], trx?: DbTransaction): Promise<PurchasableVariant[]> {
    if (variantIds.length === 0) return [];
    const result = await this.exec(trx).raw<{ rows: PurchaseRow[] }>(
      `SELECT v.id AS variant_id, v.product_id, p.name AS product_name, p.slug AS product_slug,
              v.sku, v.price, v.seller_id,
              (v.status = ? AND v.deleted_at IS NULL
                 AND p.status = ? AND p.seller_active AND p.deleted_at IS NULL) AS purchasable,
              COALESCE((
                SELECT json_agg(json_build_object('attribute', a.name, 'value', o.value)
                                ORDER BY c.depth, a.sort_order, a.code)
                  FROM ${VALUES} x
                  JOIN ${ATTRIBUTES} a ON a.id = x.attribute_id
                  JOIN ${CATEGORIES} c ON c.id = a.category_id
                  JOIN ${OPTIONS} o ON o.id = x.option_id
                 WHERE x.variant_id = v.id
              ), '[]'::json) AS attributes
         FROM ${T} v
         JOIN ${PRODUCTS} p ON p.id = v.product_id
        WHERE v.id = ANY(?::uuid[])`,
      [VariantStatus.ACTIVE, ProductStatus.ACTIVE, [...new Set(variantIds)]],
    );
    return result.rows.map((row) => ({
      variantId: row.variant_id,
      productId: row.product_id,
      productName: row.product_name,
      productSlug: row.product_slug,
      sku: row.sku,
      price: row.price,
      sellerId: row.seller_id,
      attributes: row.attributes,
      purchasable: row.purchasable,
    }));
  }

  async softDeleteByProduct(productId: string, trx: DbTransaction): Promise<void> {
    await trx<ProductVariantTable>(T).where({ product_id: productId }).whereNull('deleted_at').update({
      deleted_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });
  }
}
