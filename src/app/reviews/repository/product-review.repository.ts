import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { applyListQuery, type ParsedListQuery } from '../../../lib/http';
import { type Rating, REVIEW_TABLES } from '../constants';
import { ReviewStatus } from '../enums';
import { type NewProductReview, type ProductReview } from '../model/review.model';

const T = REVIEW_TABLES.PRODUCT_REVIEWS;
const COLUMNS = [
  'id',
  'product_id',
  'seller_id',
  'customer_id',
  'order_item_id',
  'variant_id',
  'variant_options',
  'rating',
  'title',
  'body',
  'status',
  'hidden_reason',
  'hidden_at',
  'edited_at',
  'deleted_at',
  'created_at',
] as const;

interface ProductReviewTable {
  id: string;
  product_id: string;
  seller_id: string;
  customer_id: string;
  order_item_id: string;
  variant_id: string;
  variant_options: { attribute: string; value: string }[];
  rating: Rating;
  title: string | null;
  body: string | null;
  status: ReviewStatus;
  hidden_reason: string | null;
  hidden_by_user_id: string | null;
  hidden_at: Date | null;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type ProductReviewRow = Pick<ProductReviewTable, (typeof COLUMNS)[number]>;

function toModel(row: ProductReviewRow): ProductReview {
  return {
    id: row.id,
    productId: row.product_id,
    sellerId: row.seller_id,
    customerId: row.customer_id,
    orderItemId: row.order_item_id,
    variantId: row.variant_id,
    variantOptions: row.variant_options,
    rating: row.rating,
    title: row.title,
    body: row.body,
    status: row.status,
    hiddenReason: row.hidden_reason,
    hiddenAt: row.hidden_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  };
}

/** The columns a customer edit changes (spec 17 UC-RV-2); undefined = unchanged. */
export interface ReviewContentPatch {
  rating?: Rating;
  title?: string | null;
  body?: string | null;
}

/** All SQL of `product_reviews` (spec 17). Reads leave deleted reviews out unless they say otherwise. */
@injectable()
export class ProductReviewRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** UC-RV-1. A second live review of the product fails on uq_product_reviews_customer_id_product_id. */
  async insert(review: NewProductReview, trx: DbTransaction): Promise<ProductReview> {
    const [row] = await trx<ProductReviewTable>(T)
      .insert({
        product_id: review.productId,
        seller_id: review.sellerId,
        customer_id: review.customerId,
        order_item_id: review.orderItemId,
        variant_id: review.variantId,
        variant_options: JSON.stringify(
          review.variantOptions,
        ) as unknown as ProductReviewTable['variant_options'],
        rating: review.rating,
        title: review.title,
        body: review.body,
        status: ReviewStatus.PUBLISHED,
        hidden_reason: null,
        hidden_by_user_id: null,
        hidden_at: null,
        edited_at: null,
        deleted_at: null,
      })
      .returning(COLUMNS);
    if (!row) throw new Error('product_reviews insert returned no row');
    return toModel(row);
  }

  /** A live review of the customer, `FOR UPDATE` (UC-RV-2: lock order review → stats rows). */
  async lockForCustomer(
    id: string,
    customerId: string,
    trx: DbTransaction,
  ): Promise<ProductReview | undefined> {
    const row = await trx<ProductReviewTable>(T)
      .select(...COLUMNS)
      .where({ id, customer_id: customerId })
      .whereNull('deleted_at')
      .forUpdate()
      .first();
    return row ? toModel(row) : undefined;
  }

  async updateContent(
    id: string,
    patch: ReviewContentPatch,
    editedAt: Date,
    trx: DbTransaction,
  ): Promise<ProductReview> {
    const columns = { rating: patch.rating, title: patch.title, body: patch.body };
    const set = Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
    const [row] = await trx<ProductReviewTable>(T)
      .where({ id })
      .update({ ...set, edited_at: editedAt, updated_at: trx.fn.now() })
      .returning(COLUMNS);
    if (!row) throw new Error(`review ${id} vanished under its lock`);
    return toModel(row);
  }

  async softDelete(id: string, at: Date, trx: DbTransaction): Promise<void> {
    await trx<ProductReviewTable>(T).where({ id }).update({ deleted_at: at, updated_at: trx.fn.now() });
  }

  /** GET /me/reviews: idx_product_reviews_customer_id_created_at_id (any status, live only). */
  async listForCustomer(customerId: string, query: ParsedListQuery): Promise<ProductReview[]> {
    const qb = this.db
      .knex<ProductReviewTable>(T)
      .select(...COLUMNS)
      .where({ customer_id: customerId })
      .whereNull('deleted_at');
    const rows = (await applyListQuery(qb, query, 'id')) as ProductReviewRow[];
    return rows.map(toModel);
  }

  async findForCustomer(
    id: string,
    customerId: string,
    trx?: DbTransaction,
  ): Promise<ProductReview | undefined> {
    const row = await this.exec(trx)<ProductReviewTable>(T)
      .select(...COLUMNS)
      .where({ id, customer_id: customerId })
      .whereNull('deleted_at')
      .first();
    return row ? toModel(row) : undefined;
  }

  /** The products the customer has a live review of (RV-12), on uq_product_reviews_customer_id_product_id. */
  async findReviewedProductIds(customerId: string): Promise<string[]> {
    const rows = await this.db
      .knex<ProductReviewTable>(T)
      .select('product_id')
      .where({ customer_id: customerId })
      .whereNull('deleted_at');
    return rows.map((row) => row.product_id);
  }

  /**
   * GET /products/:productId/reviews: published, live reviews (idx_product_reviews_product_id_created_at_id;
   * the rating filter and sort read within one product). `hasImages` is a custom filter (EXISTS).
   */
  async listPublic(
    productId: string,
    query: ParsedListQuery,
    hasImages: boolean | undefined,
  ): Promise<ProductReview[]> {
    const qb = this.publishedQuery().where('r.product_id', productId);
    this.filterImages(qb, hasImages);
    const rows = (await applyListQuery(qb, query, 'r.id')) as ProductReviewRow[];
    return rows.map(toModel);
  }

  /**
   * GET /seller/reviews: the seller's published, live reviews (idx_product_reviews_seller_id_created_at_id).
   * `replied` is a custom filter (EXISTS on uq_review_replies_review_id).
   */
  async listForSeller(
    sellerId: string,
    query: ParsedListQuery,
    replied: boolean | undefined,
  ): Promise<ProductReview[]> {
    const qb = this.publishedQuery().where('r.seller_id', sellerId);
    if (replied !== undefined) {
      const reply = this.db
        .knex(`${REVIEW_TABLES.REVIEW_REPLIES} as rr`)
        .select(this.db.knex.raw('1'))
        .whereRaw('rr.review_id = r.id');
      void (replied ? qb.whereExists(reply) : qb.whereNotExists(reply));
    }
    const rows = (await applyListQuery(qb, query, 'r.id')) as ProductReviewRow[];
    return rows.map(toModel);
  }

  /** GET /admin/reviews: every live review, any status (idx_product_reviews_created_at_id unfiltered). */
  async listForAdmin(query: ParsedListQuery): Promise<ProductReview[]> {
    const qb = this.db
      .knex(`${T} as r`)
      .select(...COLUMNS.map((c) => `r.${c}`))
      .whereNull('r.deleted_at');
    const rows = (await applyListQuery(qb, query, 'r.id')) as ProductReviewRow[];
    return rows.map(toModel);
  }

  /** A live review by id, any status (admin reads). */
  async findLiveById(id: string): Promise<ProductReview | undefined> {
    const row = await this.db
      .knex<ProductReviewTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .whereNull('deleted_at')
      .first();
    return row ? toModel(row) : undefined;
  }

  /** A live review `FOR UPDATE` (UC-RV-3, UC-RV-4): of `sellerId` when given, else any (admin). */
  async lockLive(id: string, trx: DbTransaction, sellerId?: string): Promise<ProductReview | undefined> {
    const query = trx<ProductReviewTable>(T)
      .select(...COLUMNS)
      .where({ id })
      .whereNull('deleted_at')
      .forUpdate();
    if (sellerId !== undefined) void query.andWhere({ seller_id: sellerId });
    const row = await query.first();
    return row ? toModel(row) : undefined;
  }

  /** UC-RV-4: hide (with the reason and the admin) or unhide (the hide columns cleared). */
  async setVisibility(
    id: string,
    hidden: { reason: string; byUserId: string; at: Date } | null,
    trx: DbTransaction,
  ): Promise<ProductReview> {
    const [row] = await trx<ProductReviewTable>(T)
      .where({ id })
      .update({
        status: hidden ? ReviewStatus.HIDDEN : ReviewStatus.PUBLISHED,
        hidden_reason: hidden?.reason ?? null,
        hidden_by_user_id: hidden?.byUserId ?? null,
        hidden_at: hidden?.at ?? null,
        updated_at: trx.fn.now(),
      })
      .returning(COLUMNS);
    if (!row) throw new Error(`review ${id} vanished under its lock`);
    return toModel(row);
  }

  private publishedQuery() {
    return this.db
      .knex(`${T} as r`)
      .select(...COLUMNS.map((c) => `r.${c}`))
      .where('r.status', ReviewStatus.PUBLISHED)
      .whereNull('r.deleted_at');
  }

  private filterImages(
    qb: ReturnType<ProductReviewRepository['publishedQuery']>,
    hasImages: boolean | undefined,
  ): void {
    if (hasImages === undefined) return;
    const images = this.db
      .knex(`${REVIEW_TABLES.REVIEW_IMAGES} as ri`)
      .select(this.db.knex.raw('1'))
      .whereRaw('ri.review_id = r.id');
    void (hasImages ? qb.whereExists(images) : qb.whereNotExists(images));
  }
}
