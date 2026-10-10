import { IsBoolean } from 'class-validator';
import { IntField, Nullable, Optional, PatchDto, SlugField, StrField, UuidField } from '../../../lib/http';
import {
  ATTRIBUTE_CODE_MAX_LENGTH,
  ATTRIBUTE_NAME_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  CATEGORY_SLUG_MAX_LENGTH,
  OPTION_CODE_MAX_LENGTH,
  OPTION_VALUE_MAX_LENGTH,
  SORT_ORDER_MAX,
} from '../constants';

/** Request DTOs for spec 06 §4.1–§4.2. */

export class CategoryIdParamsDto {
  @UuidField()
  categoryId!: string;
}

export class AttributeIdParamsDto {
  @UuidField()
  attributeId!: string;
}

export class OptionIdParamsDto {
  @UuidField()
  optionId!: string;
}

export class CreateCategoryDto {
  /** Absent or null = a root category. */
  @Optional()
  @Nullable()
  @UuidField()
  parentId?: string | null;

  @StrField(1, CATEGORY_NAME_MAX_LENGTH)
  name!: string;

  /** Defaults to the kebab-cased name. */
  @Optional()
  @SlugField(1, CATEGORY_SLUG_MAX_LENGTH)
  slug?: string;

  @IntField(0, SORT_ORDER_MAX)
  sortOrder!: number;
}

export class UpdateCategoryDto extends PatchDto {
  @Optional()
  @StrField(1, CATEGORY_NAME_MAX_LENGTH)
  name?: string;

  @Optional()
  @SlugField(1, CATEGORY_SLUG_MAX_LENGTH)
  slug?: string;

  @Optional()
  @IntField(0, SORT_ORDER_MAX)
  sortOrder?: number;

  @Optional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateAttributeDto {
  @StrField(1, ATTRIBUTE_NAME_MAX_LENGTH)
  name!: string;

  /** The public filter key (`attr.<code>`); immutable. */
  @SlugField(1, ATTRIBUTE_CODE_MAX_LENGTH)
  code!: string;

  @IntField(0, SORT_ORDER_MAX)
  sortOrder!: number;
}

export class UpdateAttributeDto extends PatchDto {
  @Optional()
  @StrField(1, ATTRIBUTE_NAME_MAX_LENGTH)
  name?: string;

  @Optional()
  @IntField(0, SORT_ORDER_MAX)
  sortOrder?: number;
}

export class CreateOptionDto {
  @StrField(1, OPTION_VALUE_MAX_LENGTH)
  value!: string;

  @SlugField(1, OPTION_CODE_MAX_LENGTH)
  code!: string;

  @IntField(0, SORT_ORDER_MAX)
  sortOrder!: number;
}

export class UpdateOptionDto extends PatchDto {
  @Optional()
  @StrField(1, OPTION_VALUE_MAX_LENGTH)
  value?: string;

  @Optional()
  @IntField(0, SORT_ORDER_MAX)
  sortOrder?: number;
}
