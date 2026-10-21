import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';
import {
  FieldType,
  IntField,
  type ListSpec,
  Nullable,
  Optional,
  PatchDto,
  StrField,
  UuidField,
} from '../../../lib/http';
import { type Rating, REVIEW_LIMITS } from '../constants';

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
