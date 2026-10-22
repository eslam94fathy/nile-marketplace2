import { inject, injectable } from 'tsyringe';
import { type AuditValues, type IAuditRecorder } from '../../../lib/audit';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { slugify } from '../../../pkg/text';
import { MediaPurpose, type MediaService } from '../../media';
import {
  CATEGORY_MAX_DEPTH,
  CATEGORY_SLUG_MAX_LENGTH,
  MAX_CHILDREN_PER_CATEGORY,
  MAX_EFFECTIVE_ATTRIBUTES,
  MAX_OPTIONS_PER_ATTRIBUTE,
} from '../constants';
import {
  attributeCodeConflict,
  attributeInUse,
  attributeLimitReached,
  attributeNotFound,
  categoryChildLimitReached,
  categoryHasProducts,
  categoryInUse,
  categoryMaxDepthExceeded,
  categoryNotFound,
  categoryParentInactive,
  categoryReferenceNotFound,
  categorySlugRequired,
  optionInUse,
  optionLimitReached,
  optionNotFound,
} from '../errors';
import {
  type AttributeWithOptions,
  type Category,
  type CategoryAttribute,
  type CategoryAttributeOption,
  type CategoryTree,
} from '../model/category-tree.model';
import { type CategoryAttributeOptionRepository } from '../repository/category-attribute-option.repository';
import { type CategoryAttributeRepository } from '../repository/category-attribute.repository';
import { type CategoryRepository } from '../repository/category.repository';
import { type ProductRepository } from '../repository/product.repository';
import { type VariantAttributeValueRepository } from '../repository/variant-attribute-value.repository';
import { type CategoryTreeService } from './category-tree.service';

export interface CreateCategoryInput {
  parentId: string | null;
  name: string;
  slug?: string;
  sortOrder: number;
}
export interface UpdateCategoryInput {
  name?: string;
  slug?: string;
  sortOrder?: number;
  isActive?: boolean;
}
export interface CreateAttributeInput {
  name: string;
  code: string;
  sortOrder: number;
}
export interface CreateOptionInput {
  value: string;
  code: string;
  sortOrder: number;
}

/** A subtree can gain a child between the unlocked read and the lock: retry with the new set. */
const MAX_SUBTREE_LOCK_ATTEMPTS = 3;

/**
 * Admin management of the category tree, attributes and options (spec 06 UC-CA-1, UC-CA-2).
 * Every write runs in one transaction that first locks the category rows its checks depend on
 * (spec 06 CA-2), re-reads the tree inside that transaction, and deletes the tree cache after commit.
 *
 * Lock sets:
 * - category create: the parent (depth, child limit).
 * - category update: the category itself (children and products checks, parent state).
 * - attribute add / delete: the category's whole subtree, in id order. An ancestor's subtree contains
 *   the descendant, so writes along one lineage always overlap and serialise (code uniqueness, the
 *   effective-attribute limit, "no products in the subtree").
 * - option add: the attribute row (option limit).
 */
@injectable()
export class CategoryAdminService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.CategoryTreeService) private readonly trees: CategoryTreeService,
    @inject(TOKENS.CategoryRepository) private readonly categories: CategoryRepository,
    @inject(TOKENS.CategoryAttributeRepository) private readonly attributes: CategoryAttributeRepository,
    @inject(TOKENS.CategoryAttributeOptionRepository)
    private readonly options: CategoryAttributeOptionRepository,
    @inject(TOKENS.ProductRepository) private readonly products: ProductRepository,
    @inject(TOKENS.VariantAttributeValueRepository)
    private readonly variantValues: VariantAttributeValueRepository,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
  ) {}

  /**
   * Includes inactive categories (spec 06 §4.2). Read fresh, not from the cache: admin traffic is
   * tiny, and a response right after a write must show that write.
   */
  getTree(): Promise<CategoryTree> {
    return this.trees.load();
  }

  async createCategory(input: CreateCategoryInput, actorUserId: string): Promise<string> {
    const slug = input.slug ?? slugify(input.name, CATEGORY_SLUG_MAX_LENGTH);
    if (slug === '') throw categorySlugRequired();

    const id = await this.tx.run(async (trx) => {
      let depth = 1;
      if (input.parentId !== null) {
        await this.categories.lockForUpdate([input.parentId], trx);
        const tree = await this.trees.load(trx);
        const parent = tree.get(input.parentId);
        if (!parent) throw categoryReferenceNotFound();
        if (!parent.isActive) throw categoryParentInactive();
        depth = parent.depth + 1;
        if (depth > CATEGORY_MAX_DEPTH) throw categoryMaxDepthExceeded(CATEGORY_MAX_DEPTH);
        if (tree.children(parent.id).length >= MAX_CHILDREN_PER_CATEGORY) {
          throw categoryChildLimitReached(MAX_CHILDREN_PER_CATEGORY);
        }
      }
      const created = {
        parentId: input.parentId,
        name: input.name,
        slug,
        depth,
        sortOrder: input.sortOrder,
        isActive: true,
      };
      const categoryId = await this.categories.insert(created, trx);
      await this.audit.record(
        { action: 'category.created', targetId: categoryId, after: categoryValues(created) },
        trx,
      );
      return categoryId;
    });
    await this.changed('category created', { categoryId: id, actorUserId });
    return id;
  }

  async updateCategory(categoryId: string, input: UpdateCategoryInput, actorUserId: string): Promise<void> {
    await this.tx.run(async (trx) => {
      await this.categories.lockForUpdate([categoryId], trx);
      const tree = await this.trees.load(trx);
      const category = tree.get(categoryId);
      if (!category) throw categoryNotFound();

      if (input.isActive === false && category.isActive) {
        const activeChild = tree.children(categoryId).some((child) => child.isActive);
        if (
          activeChild ||
          (await this.products.existsInCategories([categoryId], { includeDeleted: false }, trx))
        ) {
          throw categoryInUse();
        }
      }
      if (input.isActive === true && !category.isActive && category.parentId !== null) {
        // An active category always has an active parent (spec 06 CA-13).
        if (!tree.isActive(category.parentId)) throw categoryParentInactive();
      }
      await this.categories.update(categoryId, input, trx);
      await this.audit.record(
        {
          action: 'category.updated',
          targetId: categoryId,
          before: categoryValues(category),
          after: categoryValues({ ...category, ...definedOnly(input) }),
        },
        trx,
      );
    });
    await this.changed('category updated', { categoryId, actorUserId });
  }

  async addAttribute(categoryId: string, input: CreateAttributeInput, actorUserId: string): Promise<string> {
    const id = await this.tx.run(async (trx) => {
      const tree = await this.lockSubtree(categoryId, trx);
      if (!tree.get(categoryId)) throw categoryNotFound();
      if (tree.codeExistsInLineage(categoryId, input.code)) throw attributeCodeConflict();
      if (
        await this.products.existsInCategories(tree.subtreeIds(categoryId), { includeDeleted: false }, trx)
      ) {
        throw categoryHasProducts();
      }
      if (tree.maxEffectiveAttributeCount(categoryId) + 1 > MAX_EFFECTIVE_ATTRIBUTES) {
        throw attributeLimitReached(MAX_EFFECTIVE_ATTRIBUTES);
      }
      const attributeId = await this.attributes.insert({ categoryId, ...input }, trx);
      await this.audit.record(
        {
          action: 'attribute.created',
          targetId: attributeId,
          after: attributeValues({ categoryId, ...input }),
        },
        trx,
      );
      return attributeId;
    });
    await this.changed('category attribute added', { categoryId, attributeId: id, actorUserId });
    return id;
  }

  async updateAttribute(
    attributeId: string,
    input: { name?: string; sortOrder?: number },
    actorUserId: string,
  ): Promise<void> {
    await this.tx.run(async (trx) => {
      const attribute = await this.attributes.findForUpdate(attributeId, trx);
      if (!attribute) throw attributeNotFound();
      await this.attributes.update(attributeId, input, trx);
      await this.audit.record(
        {
          action: 'attribute.updated',
          targetId: attributeId,
          before: attributeValues(attribute),
          after: attributeValues({ ...attribute, ...definedOnly(input) }),
        },
        trx,
      );
    });
    await this.changed('category attribute updated', { attributeId, actorUserId });
  }

  async deleteAttribute(attributeId: string, actorUserId: string): Promise<void> {
    const attribute = (await this.trees.load()).attribute(attributeId);
    if (!attribute) throw attributeNotFound();
    await this.tx.run(async (trx) => {
      const tree = await this.lockSubtree(attribute.categoryId, trx);
      if (!tree.attribute(attributeId)) throw attributeNotFound();
      // Deleted products count: their variants still point at the attribute (spec 06 UC-CA-2).
      if (
        await this.products.existsInCategories(
          tree.subtreeIds(attribute.categoryId),
          { includeDeleted: true },
          trx,
        )
      ) {
        throw attributeInUse();
      }
      await this.options.deleteByAttribute(attributeId, trx);
      await this.attributes.delete(attributeId, trx);
      await this.audit.record(
        { action: 'attribute.deleted', targetId: attributeId, before: attributeValues(attribute) },
        trx,
      );
    });
    await this.changed('category attribute deleted', { attributeId, actorUserId });
  }

  async addOption(attributeId: string, input: CreateOptionInput, actorUserId: string): Promise<string> {
    const id = await this.tx.run(async (trx) => {
      if (!(await this.attributes.findForUpdate(attributeId, trx))) throw attributeNotFound();
      if ((await this.options.countByAttribute(attributeId, trx)) >= MAX_OPTIONS_PER_ATTRIBUTE) {
        throw optionLimitReached(MAX_OPTIONS_PER_ATTRIBUTE);
      }
      const optionId = await this.options.insert({ attributeId, ...input }, trx);
      await this.audit.record(
        { action: 'option.created', targetId: optionId, after: optionValues({ attributeId, ...input }) },
        trx,
      );
      return optionId;
    });
    await this.changed('attribute option added', { attributeId, optionId: id, actorUserId });
    return id;
  }

  async updateOption(
    optionId: string,
    input: { value?: string; sortOrder?: number },
    actorUserId: string,
  ): Promise<CategoryAttributeOption> {
    const option = await this.tx.run(async (trx) => {
      const current = await this.options.findById(optionId, trx, { forUpdate: true });
      if (!current) throw optionNotFound();
      await this.options.update(optionId, input, trx);
      const updated = await this.options.findById(optionId, trx);
      await this.audit.record(
        {
          action: 'option.updated',
          targetId: optionId,
          before: optionValues(current),
          after: optionValues(updated ?? current),
        },
        trx,
      );
      return updated;
    });
    if (!option) throw optionNotFound();
    await this.changed('attribute option updated', { optionId, actorUserId });
    return option;
  }

  async deleteOption(optionId: string, actorUserId: string): Promise<void> {
    await this.tx.run(async (trx) => {
      const option = await this.options.findById(optionId, trx);
      if (!option) throw optionNotFound();
      // Deleted variants count. A variant inserted concurrently is caught by the FK (23001 → OPTION_IN_USE).
      if (await this.variantValues.isOptionUsed(optionId, trx)) throw optionInUse();
      await this.options.delete(optionId, trx);
      await this.audit.record(
        { action: 'option.deleted', targetId: optionId, before: optionValues(option) },
        trx,
      );
    });
    await this.changed('attribute option deleted', { optionId, actorUserId });
  }

  /** Attribute of the fresh tree, for responses. */
  async attributeById(attributeId: string): Promise<AttributeWithOptions> {
    const attribute = (await this.trees.load()).attribute(attributeId);
    if (!attribute) throw attributeNotFound();
    return attribute;
  }

  /**
   * Locks the category's subtree (in id order) and returns the tree read after the locks. If a
   * child appeared between the unlocked read and the lock, the new set is locked too.
   */
  private async lockSubtree(categoryId: string, trx: DbTransaction): Promise<CategoryTree> {
    const locked = new Set<string>();
    let tree = await this.trees.load(trx);
    for (let attempt = 0; attempt < MAX_SUBTREE_LOCK_ATTEMPTS; attempt += 1) {
      const missing = tree.subtreeIds(categoryId).filter((id) => !locked.has(id));
      if (missing.length === 0) return tree;
      await this.categories.lockForUpdate(missing, trx);
      for (const id of missing) locked.add(id);
      // Read committed: this read sees every change committed before the locks were granted.
      tree = await this.trees.load(trx);
    }
    throw new Error(`category ${categoryId}: subtree kept changing while locking it`);
  }

  /**
   * Spec 06 UC-CA-9: any admin's upload (ME-2) replaces the current image, which is released. The same
   * image again only changes the alt text (CA-17).
   */
  async setImage(
    categoryId: string,
    mediaId: string,
    altText: string | null,
    actorUserId: string,
  ): Promise<void> {
    await this.tx.run(async (trx) => {
      const current = await this.lockedImage(categoryId, trx);
      if (current?.mediaId !== mediaId) {
        await this.media.claim(
          [mediaId],
          { purpose: MediaPurpose.CATEGORY_IMAGE, ownerUserId: actorUserId },
          trx,
        );
      }
      await this.categories.setImage(categoryId, mediaId, altText, trx);
      if (current && current.mediaId !== mediaId) await this.media.release([current.mediaId], trx);
      await this.audit.record(
        {
          action: 'category.image_set',
          targetId: categoryId,
          before: imageValues(current),
          after: { imageMediaId: mediaId, imageAltText: altText },
        },
        trx,
      );
    });
    await this.changed('category image set', { categoryId, actorUserId });
  }

  /** Removing a missing image is a no-op (still 204, not audited). */
  async removeImage(categoryId: string, actorUserId: string): Promise<void> {
    const removed = await this.tx.run(async (trx) => {
      const current = await this.lockedImage(categoryId, trx);
      if (!current) return false;
      await this.categories.setImage(categoryId, null, null, trx);
      await this.media.release([current.mediaId], trx);
      await this.audit.record(
        {
          action: 'category.image_removed',
          targetId: categoryId,
          before: imageValues(current),
          after: imageValues(null),
        },
        trx,
      );
      return true;
    });
    if (removed) await this.changed('category image removed', { categoryId, actorUserId });
  }

  /** Locks the category (CA-2) and returns its current image, if any. */
  private async lockedImage(categoryId: string, trx: DbTransaction) {
    const [locked] = await this.categories.lockForUpdate([categoryId], trx);
    if (!locked) throw categoryNotFound();
    return this.categories.findImage(categoryId, trx);
  }

  private async changed(message: string, fields: Record<string, string>): Promise<void> {
    await this.trees.invalidate();
    this.logger.info(message, { event: 'CATALOG_TAXONOMY_CHANGED', ...fields });
  }
}

/** Audited fields of a category (spec 20 §2.3). */
function categoryValues(category: Omit<Category, 'id' | 'depth'>): AuditValues {
  return {
    name: category.name,
    slug: category.slug,
    sortOrder: category.sortOrder,
    isActive: category.isActive,
    parentId: category.parentId,
  };
}

function attributeValues(attribute: Omit<CategoryAttribute, 'id'>): AuditValues {
  return {
    name: attribute.name,
    code: attribute.code,
    sortOrder: attribute.sortOrder,
    categoryId: attribute.categoryId,
  };
}

function optionValues(option: Omit<CategoryAttributeOption, 'id'>): AuditValues {
  return {
    value: option.value,
    code: option.code,
    sortOrder: option.sortOrder,
    attributeId: option.attributeId,
  };
}

function imageValues(image: { mediaId: string; altText: string | null } | null): AuditValues {
  return { imageMediaId: image?.mediaId ?? null, imageAltText: image?.altText ?? null };
}

/** A patch without its absent fields, so spreading it never overwrites a value with `undefined`. */
function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}
