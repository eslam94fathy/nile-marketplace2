import { describe, expect, it } from 'vitest';
import { type Category, CategoryTree, type CategoryTreeSnapshot } from '../model/category-tree.model';

const category = (id: string, parentId: string | null, depth: number, overrides: Partial<Category> = {}) => ({
  id,
  parentId,
  name: id,
  slug: id,
  depth,
  sortOrder: 0,
  isActive: true,
  ...overrides,
});
const attribute = (id: string, categoryId: string, code: string, sortOrder = 0) => ({
  id,
  categoryId,
  name: code,
  code,
  sortOrder,
});

//   fashion ── clothing ── shirts
//          └── shoes
//   phones
const tree = CategoryTree.fromSnapshot({
  categories: [
    category('shirts', 'clothing', 3),
    category('fashion', null, 1, { sortOrder: 2 }),
    category('phones', null, 1, { sortOrder: 1 }),
    category('shoes', 'fashion', 2, { sortOrder: 1 }),
    category('clothing', 'fashion', 2, { sortOrder: 0 }),
  ],
  attributes: [
    attribute('a-size', 'clothing', 'size', 1),
    attribute('a-fit', 'shirts', 'fit'),
    attribute('a-brand', 'fashion', 'brand'),
    attribute('a-color', 'clothing', 'color', 0),
  ],
  options: [
    { id: 'o-xl', attributeId: 'a-size', value: 'XL', code: 'xl', sortOrder: 2 },
    { id: 'o-s', attributeId: 'a-size', value: 'S', code: 's', sortOrder: 1 },
  ],
});

describe('CategoryTree', () => {
  it('orders children by sortOrder, then name', () => {
    expect(tree.children(null).map((c) => c.id)).toEqual(['phones', 'fashion']);
    expect(tree.children('fashion').map((c) => c.id)).toEqual(['clothing', 'shoes']);
  });

  it('builds the path root-first and the subtree pre-order', () => {
    expect(tree.path('shirts').map((c) => c.id)).toEqual(['fashion', 'clothing', 'shirts']);
    expect(tree.subtreeIds('fashion')).toEqual(['fashion', 'clothing', 'shirts', 'shoes']);
    expect(tree.path('unknown')).toEqual([]);
    expect(tree.subtreeIds('unknown')).toEqual([]);
  });

  it('effective attributes: ancestors first, then sortOrder; options sorted', () => {
    expect(tree.effectiveAttributes('shirts').map((a) => a.code)).toEqual(['brand', 'color', 'size', 'fit']);
    expect(tree.attribute('a-size')?.options.map((o) => o.code)).toEqual(['s', 'xl']);
    expect(tree.effectiveAttributes('phones')).toEqual([]);
  });

  it('the largest effective count in a subtree bounds what one more attribute may add', () => {
    expect(tree.maxEffectiveAttributeCount('fashion')).toBe(4); // shirts
    expect(tree.maxEffectiveAttributeCount('shoes')).toBe(1);
    expect(tree.maxEffectiveAttributeCount('unknown')).toBe(0);
  });

  it('a code is taken on the category, any ancestor, or any descendant, but not on a sibling branch', () => {
    expect(tree.codeExistsInLineage('clothing', 'fit')).toBe(true); // descendant
    expect(tree.codeExistsInLineage('shirts', 'brand')).toBe(true); // ancestor
    expect(tree.codeExistsInLineage('shoes', 'size')).toBe(false); // sibling branch
    expect(tree.codeExistsInLineage('phones', 'brand')).toBe(false);
  });

  it('round-trips through its snapshot (the cache format)', () => {
    const copy = CategoryTree.fromSnapshot(
      JSON.parse(JSON.stringify(tree.toSnapshot())) as CategoryTreeSnapshot,
    );
    expect(copy.effectiveAttributes('shirts')).toEqual(tree.effectiveAttributes('shirts'));
  });
});
