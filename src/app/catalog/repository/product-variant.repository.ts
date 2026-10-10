import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { Money } from '../../../lib/money';
import { CATALOG_TABLES } from '../constants';
import { type VariantStatus } from '../enums';
import { ProductVariant } from '../model/product-variant.model';

const T = CATALOG_TABLES.PRODUCT_VARIANTS;
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

  async softDeleteByProduct(productId: string, trx: DbTransaction): Promise<void> {
    await trx<ProductVariantTable>(T).where({ product_id: productId }).whereNull('deleted_at').update({
      deleted_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });
  }
}
