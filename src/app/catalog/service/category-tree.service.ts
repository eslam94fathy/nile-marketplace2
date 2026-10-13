import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ILogger } from '../../../lib/logger';
import { type ICache } from '../../../pkg/cache';
import { CATEGORY_TREE_CACHE_KEY } from '../constants';
import { CategoryTree, type CategoryTreeSnapshot } from '../model/category-tree.model';
import { type CategoryAttributeOptionRepository } from '../repository/category-attribute-option.repository';
import { type CategoryAttributeRepository } from '../repository/category-attribute.repository';
import { type CategoryRepository } from '../repository/category.repository';

type CacheEnv = Pick<Env, 'CATEGORY_TREE_CACHE_TTL_SECONDS'>;

/**
 * The category tree with attributes and options, cache-aside (architecture §8, spec 06 CA-8).
 * Redis is never the source of truth: every cache failure falls back to the DB with a `warn`.
 */
@injectable()
export class CategoryTreeService {
  constructor(
    @inject(TOKENS.CategoryRepository) private readonly categories: CategoryRepository,
    @inject(TOKENS.CategoryAttributeRepository) private readonly attributes: CategoryAttributeRepository,
    @inject(TOKENS.CategoryAttributeOptionRepository)
    private readonly options: CategoryAttributeOptionRepository,
    @inject(TOKENS.Cache) private readonly cache: ICache,
    @inject(TOKENS.Env) private readonly env: CacheEnv,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  /** Cached read, for request paths. */
  async getTree(): Promise<CategoryTree> {
    const cached = await this.readCache();
    if (cached) return cached;
    const tree = await this.load();
    await this.writeCache(tree);
    return tree;
  }

  /** Fresh read inside a transaction (after taking locks): admin writes never trust the cache. */
  async load(trx?: DbTransaction): Promise<CategoryTree> {
    // Sequential: a transaction is one connection, which runs one query at a time.
    const categories = await this.categories.findAll(trx);
    const attributes = await this.attributes.findAll(trx);
    const options = await this.options.findAll(trx);
    return CategoryTree.fromSnapshot({ categories, attributes, options });
  }

  /** After commit. A failed delete is bounded by the TTL. */
  async invalidate(): Promise<void> {
    try {
      await this.cache.delete(CATEGORY_TREE_CACHE_KEY);
    } catch (error) {
      this.logger.warn('category tree cache invalidation failed; stale until the TTL expires', {
        key: CATEGORY_TREE_CACHE_KEY,
        error,
      });
    }
  }

  private async readCache(): Promise<CategoryTree | undefined> {
    try {
      const raw = await this.cache.get(CATEGORY_TREE_CACHE_KEY);
      if (raw === null) return undefined;
      const parsed = JSON.parse(raw) as Partial<CategoryTreeSnapshot> | null;
      if (
        !Array.isArray(parsed?.categories) ||
        !Array.isArray(parsed.attributes) ||
        !Array.isArray(parsed.options)
      ) {
        throw new TypeError('cached category tree has an unexpected shape');
      }
      return CategoryTree.fromSnapshot(parsed as CategoryTreeSnapshot);
    } catch (error) {
      this.logger.warn('category tree cache read failed, reading the database', {
        key: CATEGORY_TREE_CACHE_KEY,
        error,
      });
      return undefined;
    }
  }

  private async writeCache(tree: CategoryTree): Promise<void> {
    try {
      await this.cache.set(
        CATEGORY_TREE_CACHE_KEY,
        JSON.stringify(tree.toSnapshot()),
        this.env.CATEGORY_TREE_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn('category tree cache write failed', { key: CATEGORY_TREE_CACHE_KEY, error });
    }
  }
}
