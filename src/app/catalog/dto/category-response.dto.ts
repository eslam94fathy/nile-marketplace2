import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import {
  type AttributeWithOptions,
  type CategoryAttributeOption,
  type CategoryTree,
} from '../model/category-tree.model';
import { type ActiveCategoryNode, type EffectiveAttribute } from '../service/category.service';

/* Response DTOs for spec 06 §4.1–§4.2 (decorators describe the OpenAPI shape only). */

export class CategoryNodeDto {
  @IsUUID()
  id!: string;

  @IsString()
  name!: string;

  @IsString()
  slug!: string;

  @IsInt()
  sortOrder!: number;

  @ValidateNested({ each: true })
  @Type(() => CategoryNodeDto)
  children!: CategoryNodeDto[];
}

export class AttributeOptionDto {
  @IsUUID()
  id!: string;

  @IsString()
  code!: string;

  @IsString()
  value!: string;

  @IsInt()
  sortOrder!: number;
}

export class EffectiveAttributeDto {
  @IsUUID()
  id!: string;

  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsInt()
  sortOrder!: number;

  /** The category (self or ancestor) that owns it. */
  @IsUUID()
  definedOnCategoryId!: string;

  @ValidateNested({ each: true })
  @Type(() => AttributeOptionDto)
  options!: AttributeOptionDto[];
}

/** Own attributes only (spec 06 §4.2). */
export class AdminAttributeDto {
  @IsUUID()
  id!: string;

  @IsString()
  code!: string;

  @IsString()
  name!: string;

  @IsInt()
  sortOrder!: number;

  @ValidateNested({ each: true })
  @Type(() => AttributeOptionDto)
  options!: AttributeOptionDto[];
}

export class AdminCategoryNodeDto {
  @IsUUID()
  id!: string;

  // Nullable: null for a root category.
  @IsOptional()
  @IsUUID()
  parentId!: string | null;

  @IsString()
  name!: string;

  @IsString()
  slug!: string;

  @IsInt()
  depth!: number;

  @IsInt()
  sortOrder!: number;

  @IsBoolean()
  isActive!: boolean;

  @ValidateNested({ each: true })
  @Type(() => AdminAttributeDto)
  attributes!: AdminAttributeDto[];

  @ValidateNested({ each: true })
  @Type(() => AdminCategoryNodeDto)
  children!: AdminCategoryNodeDto[];
}

export function toOptionDto(option: CategoryAttributeOption): AttributeOptionDto {
  return { id: option.id, code: option.code, value: option.value, sortOrder: option.sortOrder };
}

export function toAdminAttributeDto(attribute: AttributeWithOptions): AdminAttributeDto {
  return {
    id: attribute.id,
    code: attribute.code,
    name: attribute.name,
    sortOrder: attribute.sortOrder,
    options: attribute.options.map(toOptionDto),
  };
}

export function toEffectiveAttributeDto(attribute: EffectiveAttribute): EffectiveAttributeDto {
  return { ...toAdminAttributeDto(attribute), definedOnCategoryId: attribute.definedOnCategoryId };
}

export function toCategoryNodeDto(node: ActiveCategoryNode): CategoryNodeDto {
  const { id, name, slug, sortOrder } = node.category;
  return { id, name, slug, sortOrder, children: node.children.map(toCategoryNodeDto) };
}

/** The admin node of `categoryId` with its whole subtree (inactive categories included). */
export function toAdminCategoryNodeDto(tree: CategoryTree, categoryId: string): AdminCategoryNodeDto {
  const category = tree.get(categoryId);
  if (!category) throw new Error(`category ${categoryId} is not in the tree`);
  return {
    id: category.id,
    parentId: category.parentId,
    name: category.name,
    slug: category.slug,
    depth: category.depth,
    sortOrder: category.sortOrder,
    isActive: category.isActive,
    attributes: tree.ownAttributes(category.id).map(toAdminAttributeDto),
    children: tree.children(category.id).map((child) => toAdminCategoryNodeDto(tree, child.id)),
  };
}

export function toAdminCategoryTreeDto(tree: CategoryTree): AdminCategoryNodeDto[] {
  return tree.children(null).map((root) => toAdminCategoryNodeDto(tree, root.id));
}
