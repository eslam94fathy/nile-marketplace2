import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { ImageDto, toImageDto } from '../../media';
import { ReviewStatus } from '../enums';
import { type MyReviewView, type ReviewableItemView, type ReviewView } from '../service/review-view.service';

/* Response DTOs for spec 17 §4 (decorators describe the OpenAPI shape only). */

export class VariantOptionDto {
  @IsString()
  attribute!: string;

  @IsString()
  value!: string;
}

export class ReviewerDto {
  /** "Mona A." (RV-6); never the customer id. */
  @IsString()
  displayName!: string;
}

export class ReviewReplyDto {
  @IsString()
  body!: string;

  @IsISO8601()
  createdAt!: string;
}

export class ReviewDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  productId!: string;

  @IsInt()
  rating!: number;

  // Nullable: a rating alone is a review.
  @IsOptional()
  @IsString()
  title!: string | null;

  @IsOptional()
  @IsString()
  body!: string | null;

  /** Public images (spec 14). */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  images!: ImageDto[];

  @ValidateNested()
  @Type(() => ReviewerDto)
  reviewer!: ReviewerDto;

  /** The variant as ordered (snapshot, RV-10). */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariantOptionDto)
  variantOptions!: VariantOptionDto[];

  // Nullable: no reply yet, or an admin hid it.
  @IsOptional()
  @ValidateNested()
  @Type(() => ReviewReplyDto)
  reply!: ReviewReplyDto | null;

  @IsISO8601()
  createdAt!: string;

  @IsOptional()
  @IsISO8601()
  editedAt!: string | null;
}

export class ReviewProductDto {
  @IsUUID()
  id!: string;

  @IsString()
  slug!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImageDto)
  primaryImage!: ImageDto | null;
}

export class MyReviewDto extends ReviewDto {
  /** The author sees that it was hidden, not why. */
  @IsIn(Object.values(ReviewStatus))
  status!: ReviewStatus;

  @ValidateNested()
  @Type(() => ReviewProductDto)
  product!: ReviewProductDto;

  /** Within REVIEW_EDIT_WINDOW_DAYS of the review's creation. */
  @IsBoolean()
  canEdit!: boolean;
}

export class ReviewableProductDto {
  @IsUUID()
  id!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImageDto)
  primaryImage!: ImageDto | null;
}

export class ReviewableItemDto {
  @IsUUID()
  orderItemId!: string;

  @IsUUID()
  orderId!: string;

  @IsString()
  orderNumber!: string;

  @ValidateNested()
  @Type(() => ReviewableProductDto)
  product!: ReviewableProductDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariantOptionDto)
  variantOptions!: VariantOptionDto[];

  @IsISO8601()
  deliveredAt!: string;

  /** The last moment a review of this item can be written (REVIEW_WINDOW_DAYS after delivery). */
  @IsISO8601()
  reviewWindowEndsAt!: string;
}

export function toReviewDto(view: ReviewView): ReviewDto {
  const { review } = view;
  return {
    id: review.id,
    productId: review.productId,
    rating: review.rating,
    title: review.title,
    body: review.body,
    images: view.images.map(toImageDto),
    reviewer: { displayName: view.reviewerName },
    variantOptions: review.variantOptions.map((o) => ({ ...o })),
    reply:
      view.reply && view.reply.hiddenAt === null
        ? { body: view.reply.body, createdAt: view.reply.createdAt.toISOString() }
        : null,
    createdAt: review.createdAt.toISOString(),
    editedAt: review.editedAt?.toISOString() ?? null,
  };
}

export function toMyReviewDto(view: MyReviewView): MyReviewDto {
  const { product } = view;
  return {
    ...toReviewDto(view),
    status: view.review.status,
    product: {
      id: view.review.productId,
      slug: product?.slug ?? '',
      name: product?.name ?? '',
      primaryImage: product?.primaryImage ? toImageDto(product.primaryImage) : null,
    },
    canEdit: view.canEdit,
  };
}

export function toReviewableItemDto(view: ReviewableItemView): ReviewableItemDto {
  const { item } = view;
  return {
    orderItemId: item.orderItemId,
    orderId: item.orderId,
    orderNumber: item.orderNumber,
    product: {
      id: item.productId,
      name: item.productName,
      primaryImage: view.image ? toImageDto(view.image) : null,
    },
    variantOptions: item.attributes.map((o) => ({ ...o })),
    deliveredAt: item.deliveredAt.toISOString(),
    reviewWindowEndsAt: view.windowEndsAt.toISOString(),
  };
}
