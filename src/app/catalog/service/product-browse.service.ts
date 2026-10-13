import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { type ErrorDetail, invalidQuery } from '../../../lib/error';
import { type PageMeta, type ParsedFilter, type ParsedListQuery, toPage } from '../../../lib/http';
import { type IInventoryService } from '../../inventory';
import { type ISellerDirectory } from '../../sellers';
import { MAX_AVAILABLE_QUANTITY, SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH } from '../constants';
import { productNotFound } from '../errors';
import { type CategoryTree } from '../model/category-tree.model';
import { type Product } from '../model/product.model';
import { type ProductVariantRepository } from '../repository/product-variant.repository';
import {
  type PublicListCriteria,
  RELEVANCE_FIELD,
  type ProductRepository,
} from '../repository/product.repository';
import { type VariantAttributeValueRepository } from '../repository/variant-attribute-value.repository';
import { type CategoryTreeService } from './category-tree.service';
import { type ProductDetailCache, type ProductDetailStatic } from './product-detail-cache.service';

type SearchEnv = Pick<Env, 'SEARCH_WORD_SIMILARITY_THRESHOLD'>;

/** Query param names owned by the products list (spec 06 §4.1). */
export const PRODUCT_LIST_PARAMS = { Q: 'q', CATEGORY_ID: 'categoryId', ATTR_PREFIX: 'attr.' } as const;

export interface ProductListItem {
  product: Product;
  category: { id: string; name: string; slug: string };
  seller: { id: string; businessName: string };
}

export interface PublicProductDetail extends ProductDetailStatic {
  product: Product;
  inStock: boolean;
  /** Live per variant (never cached): sellable stock. */
  stock: Map<string, { inStock: boolean; availableQuantity: number }>;
}

/** Public browse, search and product detail (spec 06 UC-CA-6, §4.1). Visible products only. */
@injectable()
export class ProductBrowseService {
  constructor(
    @inject(TOKENS.ProductRepository) private readonly products: ProductRepository,
    @inject(TOKENS.ProductVariantRepository) private readonly variants: ProductVariantRepository,
    @inject(TOKENS.VariantAttributeValueRepository)
    private readonly values: VariantAttributeValueRepository,
    @inject(TOKENS.CategoryTreeService) private readonly trees: CategoryTreeService,
    @inject(TOKENS.ProductDetailCache) private readonly detailCache: ProductDetailCache,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.InventoryService) private readonly inventory: IInventoryService,
    @inject(TOKENS.Env) private readonly env: SearchEnv,
  ) {}

  async list(query: ParsedListQuery): Promise<{ items: ProductListItem[]; meta: PageMeta }> {
    const tree = await this.trees.getTree();
    const criteria = this.criteria(query, tree);
    const rows = await this.products.listPublic(query, criteria);
    const page = toPage(
      rows.map((row) => ({ id: row.product.id, ...row })),
      query,
      (row) => {
        if (query.sort.field === RELEVANCE_FIELD) return row.relevance ?? '0';
        if (query.sort.field === 'minPrice') return row.product.minPrice?.toString() ?? '0';
        return row.product.publishedAt ?? row.product.createdAt;
      },
    );

    const sellerIds = [...new Set(page.items.map((row) => row.product.sellerId))];
    const names = new Map(
      (await this.sellers.getSummaries(sellerIds)).map((s) => [s.sellerId, s.businessName]),
    );
    const items = page.items.map(({ product }) => {
      const category = tree.get(product.categoryId);
      return {
        product,
        category: { id: product.categoryId, name: category?.name ?? '', slug: category?.slug ?? '' },
        seller: { id: product.sellerId, businessName: names.get(product.sellerId) ?? '' },
      };
    });
    return { items, meta: page.meta };
  }

  async detail(key: { id: string } | { slug: string }): Promise<PublicProductDetail> {
    // The row is read fresh on every request: a hidden product is a 404 at once, even when cached.
    const product = await this.products.findVisible(key);
    if (!product) throw productNotFound();

    let detail = await this.detailCache.get(product.id);
    if (!detail) {
      detail = await this.buildStatic(product);
      await this.detailCache.set(product.id, detail);
    }

    const stock = await this.inventory.getStockByVariantIds(detail.variants.map((v) => v.id));
    const sellable = new Map(stock.map((s) => [s.variantId, s.sellable]));
    const live = new Map(
      detail.variants.map((variant) => {
        const units = Math.max(0, sellable.get(variant.id) ?? 0);
        return [
          variant.id,
          { inStock: units > 0, availableQuantity: Math.min(units, MAX_AVAILABLE_QUANTITY) },
        ];
      }),
    );
    return { ...detail, product, inStock: [...live.values()].some((s) => s.inStock), stock: live };
  }

  private async buildStatic(product: Product): Promise<ProductDetailStatic> {
    const tree = await this.trees.getTree();
    const active = (await this.variants.findLiveByProductIds([product.id])).filter((v) => v.isActive);
    const options = await this.values.findByVariantIds(active.map((v) => v.id));
    const [seller] = await this.sellers.getSummaries([product.sellerId]);

    const used = new Set([...options.values()].flat().map((value) => value.optionId));
    const attributes = tree
      .effectiveAttributes(product.categoryId)
      .map((attribute) => ({
        code: attribute.code,
        name: attribute.name,
        options: attribute.options
          .filter((option) => used.has(option.id))
          .map((option) => ({ code: option.code, value: option.value })),
      }))
      .filter((attribute) => attribute.options.length > 0);

    const path = tree.path(product.categoryId).map(({ id, name, slug }) => ({ id, name, slug }));
    const self = path.at(-1) ?? { id: product.categoryId, name: '', slug: '' };
    return {
      category: { ...self, path },
      seller: { id: product.sellerId, businessName: seller?.businessName ?? '' },
      attributes,
      variants: active.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        price: variant.price.toString(),
        compareAtPrice: variant.compareAtPrice?.toString() ?? null,
        options: (options.get(variant.id) ?? []).map(({ attributeCode, optionCode, value }) => ({
          attributeCode,
          optionCode,
          value,
        })),
      })),
    };
  }

  /** `q`, `categoryId` (+ descendants) and `attr.*` (spec 06 UC-CA-6, CA-5). Every problem at once. */
  private criteria(query: ParsedListQuery, tree: CategoryTree): PublicListCriteria {
    const problems: ErrorDetail[] = [];
    const rawQ = query.extra[PRODUCT_LIST_PARAMS.Q];
    const search = rawQ === undefined ? null : rawQ.trim();
    if (search !== null && (search.length < SEARCH_MIN_LENGTH || search.length > SEARCH_MAX_LENGTH)) {
      problems.push({
        field: PRODUCT_LIST_PARAMS.Q,
        constraint: 'length',
        message: `q must be ${SEARCH_MIN_LENGTH}..${SEARCH_MAX_LENGTH} characters`,
      });
    }

    const categoryFilter = query.filters.find((f) => f.field === PRODUCT_LIST_PARAMS.CATEGORY_ID);
    const categoryId = categoryFilter ? String(categoryFilter.value) : null;
    const attrFilters = query.filters.filter((f) => f.prefix?.name === PRODUCT_LIST_PARAMS.ATTR_PREFIX);
    if (attrFilters.length > 0 && categoryId === null) {
      problems.push({
        field: PRODUCT_LIST_PARAMS.ATTR_PREFIX,
        constraint: 'requires_category',
        message: 'attr.* filters need categoryId',
      });
    }

    const attributeOptionIds =
      categoryId === null
        ? []
        : attrFilters.map((filter) => resolveAttrFilter(tree, categoryId, filter, problems));
    if (problems.length > 0) throw invalidQuery(problems);
    return {
      categoryIds: categoryId === null ? null : tree.subtreeIds(categoryId),
      attributeOptionIds,
      search:
        search === null
          ? null
          : { text: search, wordSimilarityThreshold: this.env.SEARCH_WORD_SIMILARITY_THRESHOLD },
    };
  }
}

/**
 * `attr.<code>[in]=a,b`: the code resolves against the attributes of the category, its ancestors
 * and its descendants; an option code may map to several option ids (spec 06 CA-5).
 */
function resolveAttrFilter(
  tree: CategoryTree,
  categoryId: string,
  filter: ParsedFilter,
  problems: ErrorDetail[],
): string[] {
  const code = filter.prefix?.key ?? '';
  const lineage = [...tree.path(categoryId), ...tree.subtree(categoryId).slice(1)];
  const attributes = lineage.flatMap((c) => tree.ownAttributes(c.id)).filter((a) => a.code === code);
  if (attributes.length === 0) {
    problems.push({ field: filter.field, constraint: 'unknown', message: `unknown attribute "${code}"` });
    return [];
  }
  const wanted = (Array.isArray(filter.value) ? filter.value : [filter.value]).map(String);
  const ids: string[] = [];
  for (const optionCode of wanted) {
    const matches = attributes.flatMap((a) => a.options).filter((o) => o.code === optionCode);
    if (matches.length === 0) {
      problems.push({
        field: filter.field,
        constraint: 'unknown',
        message: `unknown option "${optionCode}"`,
        value: optionCode,
      });
    }
    ids.push(...matches.map((o) => o.id));
  }
  return ids;
}
