import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Nullable, Optional, PatchDto, StrField, UuidField } from '../../../lib/http';
import { ImageDto, toImageDto } from '../../media';
import { IMAGE_ALT_TEXT_MAX_LENGTH, PRODUCT_IMAGE_LIMIT } from '../constants';
import { type ProductImageView } from '../model/product-image.model';

/* Product and category image DTOs (spec 06 §8.4). An image is named by its media id (CA-15). */

export class ProductImageDto extends ImageDto {
  /** 0-based; 0 is the primary image. */
  @IsInt()
  position!: number;

  // Nullable: null when the image belongs to the product as a whole.
  @IsOptional()
  @IsUUID()
  variantId!: string | null;

  @IsOptional()
  @IsString()
  altText!: string | null;
}

export class CategoryImageDto extends ImageDto {
  @IsOptional()
  @IsString()
  altText!: string | null;
}

export class ProductImageParamsDto {
  @UuidField()
  productId!: string;

  /** The image's media id. */
  @UuidField()
  imageId!: string;
}

export class AddProductImageDto {
  @UuidField()
  mediaId!: string;

  @Optional()
  @Nullable()
  @UuidField()
  variantId?: string | null;

  @Optional()
  @Nullable()
  @StrField(1, IMAGE_ALT_TEXT_MAX_LENGTH)
  altText?: string | null;

  /** Where to insert; past the end appends. */
  @Optional()
  @IsInt()
  @Min(0)
  @Max(PRODUCT_IMAGE_LIMIT - 1)
  position?: number;
}

export class UpdateProductImageDto extends PatchDto {
  @Optional()
  @Nullable()
  @UuidField()
  variantId?: string | null;

  @Optional()
  @Nullable()
  @StrField(1, IMAGE_ALT_TEXT_MAX_LENGTH)
  altText?: string | null;
}

export class ReorderProductImagesDto {
  /** Every image (media id) of the product exactly once, in the new order. */
  @IsArray()
  @ArrayMaxSize(PRODUCT_IMAGE_LIMIT)
  @ArrayUnique()
  @IsUUID('7', { each: true })
  imageIds!: string[];
}

export class SetCategoryImageDto {
  @UuidField()
  mediaId!: string;

  @Optional()
  @Nullable()
  @StrField(1, IMAGE_ALT_TEXT_MAX_LENGTH)
  altText?: string | null;
}

export function toProductImageDto(view: ProductImageView): ProductImageDto {
  return {
    ...toImageDto(view.image),
    position: view.position,
    variantId: view.variantId,
    altText: view.altText,
  };
}
