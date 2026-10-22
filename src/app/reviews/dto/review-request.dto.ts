import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';
import {
  FieldType,
  FilterOp,
  IntField,
  type ListSpec,
  Nullable,
  Optional,
  PatchDto,
  StrField,
  UuidField,
} from '../../../lib/http';
import { type Rating, REVIEW_LIMITS } from '../constants';
import { ReviewStatus } from '../enums';

const L = REVIEW_LIMITS;

export class ReviewIdParamsDto {
  @UuidField()
  reviewId!: string;
}

/** `POST /reviews` (spec 17 §4.2). Title and body are optional: a rating alone is a review. */
export class CreateReviewDto {
  @UuidField()
  orderItemId!: string;

  @IntField(L.RATING_MIN, L.RATING_MAX)
  rating!: Rating;

  @Optional()
  @Nullable()
  @StrField(1, L.TITLE_MAX)
  title?: string | null;

  @Optional()
  @Nullable()
  @StrField(1, L.BODY_MAX)
  body?: string | null;

  /** Ready uploads of purpose review_image (RV-3). */
  @Optional()
  @IsArray()
  @ArrayMaxSize(L.MAX_IMAGES)
  @ArrayUnique()
  @IsUUID('7', { each: true })
  imageMediaIds?: string[];
}

/** `PATCH /me/reviews/:reviewId`: the same fields, all optional, at least one; images replace the list. */
export class EditReviewDto extends PatchDto {
  @Optional()
  @IntField(L.RATING_MIN, L.RATING_MAX)
  rating?: Rating;

  @Optional()
  @Nullable()
  @StrField(1, L.TITLE_MAX)
  title?: string | null;

  @Optional()
  @Nullable()
  @StrField(1, L.BODY_MAX)
  body?: string | null;

  @Optional()
  @IsArray()
  @ArrayMaxSize(L.MAX_IMAGES)
  @ArrayUnique()
  @IsUUID('7', { each: true })
  imageMediaIds?: string[];
}

/** Lists of reviews: newest first, keyset on (created_at, id) (spec 17 §4, D-11). */
export const MY_REVIEW_LIST_SPEC: ListSpec = {
  fields: { createdAt: { column: 'created_at', type: FieldType.DATE, ops: [], sortable: true } },
  defaultSort: '-createdAt',
};

/** `GET /me/reviewable-items`: newest delivery first only; the keyset is ordering's (OR-26, D-19). */
export const REVIEWABLE_ITEM_LIST_SPEC: ListSpec = {
  fields: { deliveredAt: { type: FieldType.DATE, ops: [], sortable: true } },
  defaultSort: '-deliveredAt',
};

export class ProductIdParamsDto {
  @UuidField()
  productId!: string;
}

/** `POST /seller/reviews/:reviewId/reply`: once and final (RV-5). */
export class ReplyDto {
  @StrField(1, L.REPLY_MAX)
  body!: string;
}

/** `POST /admin/reviews/:reviewId/hide` and `…/reply/hide`. */
export class HideDto {
  @StrField(L.HIDE_REASON_MIN, L.HIDE_REASON_MAX)
  reason!: string;
}

const RATING_FILTER = { column: 'r.rating', type: FieldType.NUMBER, sortable: true } as const;
const CREATED_AT = { column: 'r.created_at', type: FieldType.DATE, sortable: true } as const;

/** Spec 17 §4.1: `hasImages` has no column (an EXISTS, applied by the repository). */
export const PUBLIC_REVIEW_LIST_SPEC: ListSpec = {
  fields: {
    rating: { ...RATING_FILTER, ops: [FilterOp.EQ, FilterOp.IN] },
    hasImages: { type: FieldType.BOOLEAN, ops: [FilterOp.EQ] },
    createdAt: { ...CREATED_AT, ops: [] },
  },
  defaultSort: '-createdAt',
};

/** Spec 17 §4.3: `replied` has no column (an EXISTS on the reply). */
export const SELLER_REVIEW_LIST_SPEC: ListSpec = {
  fields: {
    productId: { column: 'r.product_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    rating: { ...RATING_FILTER, ops: [FilterOp.EQ, FilterOp.IN] },
    replied: { type: FieldType.BOOLEAN, ops: [FilterOp.EQ] },
    createdAt: { ...CREATED_AT, ops: [FilterOp.GTE, FilterOp.LTE] },
  },
  defaultSort: '-createdAt',
};

/** Spec 17 §4.4. */
export const ADMIN_REVIEW_LIST_SPEC: ListSpec = {
  fields: {
    status: {
      column: 'r.status',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ],
      enumValues: Object.values(ReviewStatus),
    },
    productId: { column: 'r.product_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    sellerId: { column: 'r.seller_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    customerId: { column: 'r.customer_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    rating: { column: 'r.rating', type: FieldType.NUMBER, ops: [FilterOp.EQ, FilterOp.IN, FilterOp.LTE] },
    createdAt: { ...CREATED_AT, ops: [FilterOp.GTE, FilterOp.LTE] },
  },
  defaultSort: '-createdAt',
};
