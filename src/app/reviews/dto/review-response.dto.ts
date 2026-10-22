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
import { ratingAverage } from '../../../lib/rating';
import { RATINGS } from '../constants';
import { ReviewStatus } from '../enums';
import { type RatingStats } from '../model/review.model';
import {
  type MyReviewView,
  type ReviewableItemView,
  type ReviewView,
  type SellerReviewView,
} from '../service/review-view.service';

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

export class RatingDistributionDto {
  @IsInt()
  1!: number;

  @IsInt()
  2!: number;

  @IsInt()
  3!: number;

  @IsInt()
  4!: number;

  @IsInt()
  5!: number;
}

export class RatingSummaryDto {
  /** "4.30" (ROUND_HALF_UP, spec 17 §1.2); null without published reviews. */
  @IsOptional()
  @IsString()
  ratingAvg!: string | null;

  @IsInt()
  ratingCount!: number;

  @ValidateNested()
  @Type(() => RatingDistributionDto)
  distribution!: RatingDistributionDto;
}

export class SellerReviewProductDto {
  @IsUUID()
  id!: string;

  @IsString()
  name!: string;
}

export class SellerReviewDto extends ReviewDto {
  @ValidateNested()
  @Type(() => SellerReviewProductDto)
  product!: SellerReviewProductDto;

  /** No reply yet, the review is published and the seller is approved. */
  @IsBoolean()
  canReply!: boolean;
}

export class AdminReplyDto {
  @IsString()
  body!: string;

  @IsISO8601()
  createdAt!: string;

  @IsOptional()
  @IsISO8601()
  hiddenAt!: string | null;

  @IsOptional()
  @IsString()
  hiddenReason!: string | null;
}

export class AdminReviewDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  productId!: string;

  @IsInt()
  rating!: number;

  @IsOptional()
  @IsString()
  title!: string | null;

  @IsOptional()
  @IsString()
  body!: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  images!: ImageDto[];

  @ValidateNested()
  @Type(() => ReviewerDto)
  reviewer!: ReviewerDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariantOptionDto)
  variantOptions!: VariantOptionDto[];

  @IsIn(Object.values(ReviewStatus))
  status!: ReviewStatus;

  @IsUUID()
  customerId!: string;

  @IsUUID()
  sellerId!: string;

  @IsUUID()
  orderItemId!: string;

  @IsOptional()
  @IsString()
  hiddenReason!: string | null;

  @IsOptional()
  @IsISO8601()
  hiddenAt!: string | null;

  /** Hidden replies too, with their hide fields. */
  @IsOptional()
  @ValidateNested()
  @Type(() => AdminReplyDto)
  reply!: AdminReplyDto | null;

  @IsISO8601()
  createdAt!: string;

  @IsOptional()
  @IsISO8601()
  editedAt!: string | null;
}

export function toRatingSummaryDto(stats: RatingStats): RatingSummaryDto {
  return {
    ratingAvg: ratingAverage(stats.ratingSum, stats.ratingCount),
    ratingCount: stats.ratingCount,
    distribution: Object.fromEntries(
      RATINGS.map((r) => [r, stats.counts[r]]),
    ) as unknown as RatingDistributionDto,
  };
}

export function toSellerReviewDto(view: SellerReviewView): SellerReviewDto {
  return {
    ...toReviewDto(view),
    product: { id: view.review.productId, name: view.productName },
    canReply: view.canReply,
  };
}

export function toAdminReviewDto(view: ReviewView): AdminReviewDto {
  const { review, reply } = view;
  const { reply: _publicReply, ...base } = toReviewDto(view);
  return {
    ...base,
    status: review.status,
    customerId: review.customerId,
    sellerId: review.sellerId,
    orderItemId: review.orderItemId,
    hiddenReason: review.hiddenReason,
    hiddenAt: review.hiddenAt?.toISOString() ?? null,
    reply: reply
      ? {
          body: reply.body,
          createdAt: reply.createdAt.toISOString(),
          hiddenAt: reply.hiddenAt?.toISOString() ?? null,
          hiddenReason: reply.hiddenReason,
        }
      : null,
  };
}
