import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { governorateNotFound } from '../../../lib/error';
import { type ILogger } from '../../../lib/logger';
import { type Money } from '../../../lib/money';
import { type ICache } from '../../../pkg/cache';
import { GOVERNORATES_CACHE_KEY } from '../constants';
import { Governorate, type GovernorateSnapshot } from '../model/governorate.model';
import { type GovernorateRepository } from '../repository/governorate.repository';

type CacheEnv = Pick<Env, 'GOVERNORATES_CACHE_TTL_SECONDS'>;

/**
 * Governorates + fees (spec 11 UC-DE-7, §4.1). Cache-aside (architecture §8, spec 11 DE-3):
 * Redis is never the source of truth, so every cache failure falls back to the DB with a `warn`.
 */
@injectable()
export class GovernorateService {
  constructor(
    @inject(TOKENS.GovernorateRepository) private readonly governorates: GovernorateRepository,
    @inject(TOKENS.Cache) private readonly cache: ICache,
    @inject(TOKENS.Env) private readonly env: CacheEnv,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  /** All 27, ordered by name. */
  async list(): Promise<Governorate[]> {
    const cached = await this.readCache();
    if (cached) return cached;
    const governorates = await this.governorates.findAll();
    await this.writeCache(governorates);
    return governorates;
  }

  /** `null` = not deliverable (Q-26). Affects new checkouts only: orders keep a snapshot. */
  async updateDeliveryFee(id: string, deliveryFee: Money | null, actorUserId: string): Promise<Governorate> {
    const updated = await this.governorates.updateDeliveryFee(id, deliveryFee);
    if (!updated) throw governorateNotFound();
    // After the (single-statement) write has committed; a failed delete is bounded by the TTL.
    await this.invalidate();
    this.logger.info('governorate delivery fee changed', {
      event: 'GOVERNORATE_FEE_CHANGED',
      governorateId: id,
      deliveryFee: updated.deliveryFee?.toString() ?? null,
      actorUserId,
    });
    return updated;
  }

  private async readCache(): Promise<Governorate[] | undefined> {
    try {
      const raw = await this.cache.get(GOVERNORATES_CACHE_KEY);
      if (raw === null) return undefined;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new TypeError('cached governorates are not an array');
      return (parsed as GovernorateSnapshot[]).map((snapshot) => Governorate.fromSnapshot(snapshot));
    } catch (error) {
      this.logger.warn('governorates cache read failed, reading the database', {
        key: GOVERNORATES_CACHE_KEY,
        error,
      });
      return undefined;
    }
  }

  private async writeCache(governorates: readonly Governorate[]): Promise<void> {
    try {
      const snapshots = governorates.map((governorate) => governorate.toSnapshot());
      await this.cache.set(
        GOVERNORATES_CACHE_KEY,
        JSON.stringify(snapshots),
        this.env.GOVERNORATES_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn('governorates cache write failed', { key: GOVERNORATES_CACHE_KEY, error });
    }
  }

  private async invalidate(): Promise<void> {
    try {
      await this.cache.delete(GOVERNORATES_CACHE_KEY);
    } catch (error) {
      this.logger.warn('governorates cache invalidation failed; stale until the TTL expires', {
        key: GOVERNORATES_CACHE_KEY,
        error,
      });
    }
  }
}
