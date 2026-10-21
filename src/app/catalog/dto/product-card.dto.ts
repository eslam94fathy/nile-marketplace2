import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { IsMoney } from '../../../lib/http';
import { ImageDto, toImageDto } from '../../media';
import { type ProductCard } from '../model/product-card.model';

/* The product card other modules show (spec 06 §9.3): the wishlist, review lists. OpenAPI shape only. */

export class ProductRatingDto {
  /** "4.30"; null without published reviews. */
  @IsOptional()
  @IsString()
  avg!: string | null;

  @IsInt()
  count!: number;
}

export class ProductCardDto {
  @IsUUID()
  id!: string;

  @IsString()
  slug!: string;

  @IsString()
  name!: string;

  // Nullable: a product without an active variant has no price.
  @IsOptional()
  @IsMoney()
  minPrice!: string | null;

  @IsOptional()
  @IsMoney()
  maxPrice!: string | null;

  @IsBoolean()
  inStock!: boolean;

  /** Publicly visible right now; false for a draft, inactive, deleted or hidden product. */
  @IsBoolean()
  available!: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImageDto)
  primaryImage!: ImageDto | null;

  @ValidateNested()
  @Type(() => ProductRatingDto)
  rating!: ProductRatingDto;
}

export function toProductCardDto(card: ProductCard): ProductCardDto {
  return {
    id: card.id,
    slug: card.slug,
    name: card.name,
    minPrice: card.minPrice,
    maxPrice: card.maxPrice,
    inStock: card.inStock,
    available: card.available,
    primaryImage: card.primaryImage ? toImageDto(card.primaryImage) : null,
    rating: { ...card.rating },
  };
}
