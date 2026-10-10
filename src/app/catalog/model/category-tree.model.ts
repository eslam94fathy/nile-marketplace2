/**
 * The whole category tree with its attributes and options (hundreds of rows), read at once and
 * cached (02-database.md §5, spec 06 CA-8). Pure and in-memory: every admin rule and public view
 * of the taxonomy is computed from it.
 */

export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  depth: number;
  sortOrder: number;
  isActive: boolean;
}

export interface CategoryAttribute {
  id: string;
  categoryId: string;
  name: string;
  code: string;
  sortOrder: number;
}

export interface CategoryAttributeOption {
  id: string;
  attributeId: string;
  value: string;
  code: string;
  sortOrder: number;
}

export interface AttributeWithOptions extends CategoryAttribute {
  options: CategoryAttributeOption[];
}

/** JSON-safe: what the cache holds. */
export interface CategoryTreeSnapshot {
  categories: Category[];
  attributes: CategoryAttribute[];
  options: CategoryAttributeOption[];
}

const bySortOrder = <T extends { sortOrder: number; id: string }>(
  label: (item: T) => string,
): ((a: T, b: T) => number) => {
  return (a, b) => a.sortOrder - b.sortOrder || label(a).localeCompare(label(b)) || a.id.localeCompare(b.id);
};
const categoryOrder = bySortOrder<Category>((c) => c.name);
const attributeOrder = bySortOrder<CategoryAttribute>((a) => a.code);
const optionOrder = bySortOrder<CategoryAttributeOption>((o) => o.value);

export class CategoryTree {
  private readonly categories = new Map<string, Category>();
  private readonly childrenOf = new Map<string | null, Category[]>();
  private readonly attributesOf = new Map<string, AttributeWithOptions[]>();
  private readonly attributes = new Map<string, AttributeWithOptions>();
  private readonly options = new Map<string, CategoryAttributeOption>();

  private constructor(private readonly snapshot: CategoryTreeSnapshot) {
    for (const category of snapshot.categories) {
      this.categories.set(category.id, category);
      const siblings = this.childrenOf.get(category.parentId) ?? [];
      siblings.push(category);
      this.childrenOf.set(category.parentId, siblings);
    }
    for (const siblings of this.childrenOf.values()) siblings.sort(categoryOrder);

    for (const attribute of snapshot.attributes) {
      const withOptions: AttributeWithOptions = { ...attribute, options: [] };
      this.attributes.set(attribute.id, withOptions);
      const own = this.attributesOf.get(attribute.categoryId) ?? [];
      own.push(withOptions);
      this.attributesOf.set(attribute.categoryId, own);
    }
    for (const own of this.attributesOf.values()) own.sort(attributeOrder);

    for (const option of snapshot.options) {
      this.options.set(option.id, option);
      this.attributes.get(option.attributeId)?.options.push(option);
    }
    for (const attribute of this.attributes.values()) attribute.options.sort(optionOrder);
  }

  static fromSnapshot(snapshot: CategoryTreeSnapshot): CategoryTree {
    return new CategoryTree(snapshot);
  }

  toSnapshot(): CategoryTreeSnapshot {
    return this.snapshot;
  }

  get(categoryId: string): Category | undefined {
    return this.categories.get(categoryId);
  }

  /** Children ordered by sortOrder, then name. `null` = the roots. */
  children(parentId: string | null): readonly Category[] {
    return this.childrenOf.get(parentId) ?? [];
  }

  /** Root first, the category itself last. Empty for an unknown id. */
  path(categoryId: string): Category[] {
    const path: Category[] = [];
    let current = this.categories.get(categoryId);
    while (current) {
      path.unshift(current);
      current = current.parentId === null ? undefined : this.categories.get(current.parentId);
    }
    return path;
  }

  /** The category and all its descendants (pre-order). Empty for an unknown id. */
  subtree(categoryId: string): Category[] {
    const root = this.categories.get(categoryId);
    if (!root) return [];
    const result: Category[] = [];
    const visit = (category: Category): void => {
      result.push(category);
      for (const child of this.children(category.id)) visit(child);
    };
    visit(root);
    return result;
  }

  subtreeIds(categoryId: string): string[] {
    return this.subtree(categoryId).map((category) => category.id);
  }

  ownAttributes(categoryId: string): readonly AttributeWithOptions[] {
    return this.attributesOf.get(categoryId) ?? [];
  }

  /** Own + inherited (Q-30): ordered by depth (ancestors first), then sortOrder. */
  effectiveAttributes(categoryId: string): AttributeWithOptions[] {
    return this.path(categoryId).flatMap((category) => this.ownAttributes(category.id));
  }

  /** The largest effective-attribute count in the subtree: adding one attribute raises all of them. */
  maxEffectiveAttributeCount(categoryId: string): number {
    return Math.max(0, ...this.subtree(categoryId).map((c) => this.effectiveAttributes(c.id).length));
  }

  /** Attributes are inherited, so a code must be unique along every root-to-leaf line (spec 06 UC-CA-2). */
  codeExistsInLineage(categoryId: string, code: string): boolean {
    const lineage = [...this.path(categoryId), ...this.subtree(categoryId).slice(1)];
    return lineage.some((category) => this.ownAttributes(category.id).some((a) => a.code === code));
  }

  attribute(attributeId: string): AttributeWithOptions | undefined {
    return this.attributes.get(attributeId);
  }

  option(optionId: string): CategoryAttributeOption | undefined {
    return this.options.get(optionId);
  }

  /** Active categories only. An active category always has an active parent (spec 06 CA-13). */
  isActive(categoryId: string): boolean {
    return this.categories.get(categoryId)?.isActive ?? false;
  }
}
