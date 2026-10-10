import { inject, injectable } from 'tsyringe';
import { type Knex } from 'knex';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { Money } from '../../../lib/money';
import { CATALOG_TABLES } from '../constants';
import { ProductStatus, VariantStatus } from '../enums';
import { type ProductProjection } from '../model/product-projection';
import { Product } from '../model/product.model';

const T = CATALOG_TABLES.PRODUCTS;
const VARIANTS = CATALOG_TABLES.PRODUCT_VARIANTS;
const VARIANT_VALUES = CATALOG_TABLES.VARIANT_ATTRIBUTE_VALUES;
const PRODUCT_STATUS_ACTIVE = ProductStatus.ACTIVE;
const VARIANT_STATUS_ACTIVE = VariantStatus.ACTIVE;

/** The sort field computed from `q` (spec 06 §4.1). */
export const RELEVANCE_FIELD = 'relevance';
/**
 * FTS rank + trigram similarity, rounded to 6 decimals so the keyset cursor compares exactly
 * (spec 06 CA-6). Binds `q` twice.
 */
const RELEVANCE_SQL = `round((ts_rank(p.search_vector, websearch_to_tsquery('english', ?)) + similarity(p.name, ?))::numeric, 6)`;

export interface PublicListCriteria {
  /** The filter category and its descendants; null = no category filter. */
  categoryIds: string[] | null;
  /** One entry per `attr.*` filter: the option ids it accepts. */
  attributeOptionIds: string[][];
  /** Trimmed `q`, or null. */
  search: string | null;
}

export interface PublicListRow {
  product: Product;
  /** The relevance score as a decimal string, when searching. */
  relevance: string | null;
}

const COLUMNS = [
  'id',
  'seller_id',
  'category_id',
  'name',
  'slug',
  'description',
  'status',
  'seller_active',
  'min_price',
  'max_price',
  'in_stock',
  'published_at',
  'deleted_at',
  'created_at',
  'updated_at',
] as const;

interface ProductTable {
  id: string;
  seller_id: string;
  category_id: string;
  name: string;
  slug: string;
  description: string;
  status: ProductStatus;
  seller_active: boolean;
  /** NUMERIC comes back from pg as a string. */
  min_price: string | null;
  max_price: string | null;
  in_stock: boolean;
  published_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type ProductRow = Pick<ProductTable, (typeof COLUMNS)[number]>;

export interface NewProduct {
  sellerId: string;
  categoryId: string;
  name: string;
  slug: string;
  description: string;
  status: ProductStatus;
  sellerActive: boolean;
  inStock: boolean;
}

export type ProductPatch = Partial<Pick<NewProduct, 'name' | 'description' | 'categoryId'>>;

function toModel(row: ProductRow): Product {
  return new Product({
    id: row.id,
    sellerId: row.seller_id,
    categoryId: row.category_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    sellerActive: row.seller_active,
    minPrice: row.min_price === null ? null : Money.of(row.min_price),
    maxPrice: row.max_price === null ? null : Money.of(row.max_price),
    inStock: row.in_stock,
    publishedAt: row.published_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

@injectable()
export class ProductRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  async insert(product: NewProduct, trx: DbTransaction): Promise<Product> {
    const [row] = await trx<ProductTable>(T)
      .insert({
        seller_id: product.sellerId,
        category_id: product.categoryId,
        name: product.name,
        slug: product.slug,
        description: product.description,
        status: product.status,
        seller_active: product.sellerActive,
        min_price: null,
        max_price: null,
        in_stock: product.inStock,
        published_at: null,
      })
      .returning<ProductRow[]>(COLUMNS);
    if (!row) throw new Error('products insert returned no row');
    return toModel(row);
  }

  /** A live product by id, any seller (event consumers). `forUpdate` requires `trx` (spec 06 CA-2). */
  async findLiveById(
    id: string,
    trx: DbTransaction,
    options: { forUpdate?: boolean } = {},
  ): Promise<Product | null> {
    const query = trx<ProductTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .whereNull('deleted_at');
    if (options.forUpdate) void query.forUpdate();
    const row = await query.first<ProductRow | undefined>();
    return row ? toModel(row) : null;
  }

  /**
   * Projection of the seller's status onto their live products (spec 06 UC-CA-7), over
   * idx_products_seller_id_created_at_id. Only rows that change are written; returns their count.
   */
  async setSellerActive(sellerId: string, active: boolean, trx: DbTransaction): Promise<number> {
    return trx<ProductTable>(T)
      .where({ seller_id: sellerId })
      .whereNull('deleted_at')
      .whereNot({ seller_active: active })
      .update({ seller_active: active, updated_at: trx.fn.now() });
  }

  /**
   * A live (not deleted) product of this seller: another seller's product is "not found" (IDOR).
   * `forUpdate` (requires `trx`) serialises every write on the product (spec 06 CA-2).
   */
  async findLiveForSeller(
    id: string,
    sellerId: string,
    trx?: DbTransaction,
    options: { forUpdate?: boolean } = {},
  ): Promise<Product | null> {
    const query = this.exec(trx)<ProductTable>(T)
      .select(...COLUMNS)
      .where({ id, seller_id: sellerId })
      .whereNull('deleted_at');
    if (options.forUpdate) void query.forUpdate();
    const row = await query.first<ProductRow | undefined>();
    return row ? toModel(row) : null;
  }

  async update(id: string, patch: ProductPatch, trx: DbTransaction): Promise<void> {
    await trx<ProductTable>(T)
      .where({ id })
      .update({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.categoryId !== undefined && { category_id: patch.categoryId }),
        updated_at: trx.fn.now(),
      });
  }

  /** `published_at` is set the first time the product goes active, and kept after that. */
  async setStatus(id: string, status: ProductStatus, publish: boolean, trx: DbTransaction): Promise<void> {
    await trx<ProductTable>(T)
      .where({ id })
      .update({
        status,
        ...(publish && { published_at: trx.raw('COALESCE(published_at, now())') }),
        updated_at: trx.fn.now(),
      });
  }

  async applyProjection(id: string, projection: ProductProjection, trx: DbTransaction): Promise<void> {
    await trx<ProductTable>(T)
      .where({ id })
      .update({
        min_price: projection.minPrice?.toString() ?? null,
        max_price: projection.maxPrice?.toString() ?? null,
        in_stock: projection.inStock,
        status: projection.status,
        updated_at: trx.fn.now(),
      });
  }

  async softDelete(id: string, trx: DbTransaction): Promise<void> {
    await trx<ProductTable>(T).where({ id }).whereNull('deleted_at').update({
      deleted_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });
  }

  /** Seller dashboard over idx_products_seller_id_created_at_id; `limit + 1` rows. */
  async listForSeller(sellerId: string, query: ParsedListQuery): Promise<Product[]> {
    const qb = this.db
      .knex<ProductTable>(T)
      .select(...COLUMNS)
      .where({ seller_id: sellerId })
      .whereNull('deleted_at');
    return ((await applyListQuery(qb, query, 'id')) as ProductRow[]).map(toModel);
  }

  /**
   * Public listing and search (spec 06 UC-CA-6, architecture §9), always within VIS. Column filters
   * and the sort come from `query` (whitelist columns are `p.*`); the custom criteria are applied
   * here. Served by the VIS partial indexes (02-database.md §5). Returns `limit + 1` rows.
   */
  async listPublic(query: ParsedListQuery, criteria: PublicListCriteria): Promise<PublicListRow[]> {
    const db = this.db.knex;
    const qb = db(`${T} as p`)
      .select(...COLUMNS.map((column) => `p.${column}`))
      .where('p.status', PRODUCT_STATUS_ACTIVE)
      .where('p.seller_active', true)
      .whereNull('p.deleted_at');

    if (criteria.categoryIds) void qb.whereIn('p.category_id', criteria.categoryIds);

    // Every attr.* condition must hold on the SAME active, live variant (spec 06 CA-5).
    if (criteria.attributeOptionIds.length > 0) {
      void qb.whereExists((variants) => {
        void variants
          .select(db.raw('1'))
          .from(`${VARIANTS} as v`)
          .whereRaw('v.product_id = p.id')
          .where('v.status', VARIANT_STATUS_ACTIVE)
          .whereNull('v.deleted_at');
        for (const optionIds of criteria.attributeOptionIds) {
          void variants.whereExists((values) => {
            void values
              .select(db.raw('1'))
              .from(`${VARIANT_VALUES} as x`)
              .whereRaw('x.variant_id = v.id')
              .whereIn('x.option_id', optionIds);
          });
        }
      });
    }

    let sortExpression: Knex.Raw | undefined;
    if (criteria.search !== null) {
      const q = criteria.search;
      void qb.where((match) => {
        void match
          .whereRaw(`p.search_vector @@ websearch_to_tsquery('english', ?)`, [q])
          .orWhereRaw('p.name % ?', [q]);
      });
      void qb.select(db.raw(`${RELEVANCE_SQL} AS relevance`, [q, q]));
      if (query.sort.field === RELEVANCE_FIELD) sortExpression = db.raw(RELEVANCE_SQL, [q, q]);
    }

    const rows = (await applyListQuery(qb, query, 'p.id', { sortExpression })) as (ProductRow & {
      relevance?: string;
    })[];
    return rows.map((row) => ({ product: toModel(row), relevance: row.relevance ?? null }));
  }

  /** A visible (VIS) product by id or by slug (uq_products_slug); null when hidden, deleted or missing. */
  async findVisible(key: { id: string } | { slug: string }): Promise<Product | null> {
    const row = await this.db
      .knex<ProductTable>(T)
      .select(...COLUMNS)
      .where('id' in key ? { id: key.id } : { slug: key.slug })
      .where({ status: PRODUCT_STATUS_ACTIVE, seller_active: true })
      .whereNull('deleted_at')
      .first<ProductRow | undefined>();
    return row ? toModel(row) : null;
  }

  /**
   * EXISTS check (G22) over idx_products_category_id (D-7). `includeDeleted`: attribute deletes
   * count soft-deleted products too, because their variants still reference the attribute.
   */
  async existsInCategories(
    categoryIds: readonly string[],
    options: { includeDeleted: boolean },
    trx?: DbTransaction,
  ): Promise<boolean> {
    if (categoryIds.length === 0) return false;
    const db = this.exec(trx);
    const products = db<ProductTable>(T)
      .select(db.raw('1'))
      .whereIn('category_id', [...new Set(categoryIds)]);
    if (!options.includeDeleted) void products.whereNull('deleted_at');
    const result = await db.raw<{ rows: { exists: boolean }[] }>('SELECT EXISTS (?) AS "exists"', [products]);
    return result.rows[0]?.exists ?? false;
  }
}
