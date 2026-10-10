import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { categoryNotFound } from '../errors';
import { type AttributeWithOptions, type Category, type CategoryTree } from '../model/category-tree.model';
import { type CategoryTreeService } from './category-tree.service';

export interface ActiveCategoryNode {
  category: Category;
  children: ActiveCategoryNode[];
}

export interface EffectiveAttribute extends AttributeWithOptions {
  /** The category (self or ancestor) that defines it. */
  definedOnCategoryId: string;
}

/** Public reads of the taxonomy (spec 06 §4.1), from the cached tree. */
@injectable()
export class CategoryService {
  constructor(@inject(TOKENS.CategoryTreeService) private readonly trees: CategoryTreeService) {}

  /** Active categories only. Inactive ones never have active children (spec 06 CA-13). */
  async activeTree(): Promise<ActiveCategoryNode[]> {
    const tree = await this.trees.getTree();
    const build = (parentId: string | null): ActiveCategoryNode[] =>
      tree
        .children(parentId)
        .filter((category) => category.isActive)
        .map((category) => ({ category, children: build(category.id) }));
    return build(null);
  }

  /** 404 for a missing or inactive category. */
  async effectiveAttributes(categoryId: string): Promise<EffectiveAttribute[]> {
    const tree = await this.trees.getTree();
    if (!tree.isActive(categoryId)) throw categoryNotFound();
    return withOwner(tree, categoryId);
  }
}

function withOwner(tree: CategoryTree, categoryId: string): EffectiveAttribute[] {
  return tree
    .effectiveAttributes(categoryId)
    .map((attribute) => ({ ...attribute, definedOnCategoryId: attribute.categoryId }));
}
