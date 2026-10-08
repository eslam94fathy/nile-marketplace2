import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ICache } from '../../../pkg/cache';
import { type IMessageBroker } from '../../../pkg/messaging';
import { Dependency, DependencyStatus } from '../enums';

export interface DependencyCheck {
  status: DependencyStatus;
  durationMs: number;
}

export interface ReadinessReport {
  status: DependencyStatus;
  checks: Record<Dependency, DependencyCheck>;
}

class CheckTimeoutError extends Error {
  override readonly name = 'CheckTimeoutError';
}

/** Readiness checks every dependency, each with its own timeout (CLAUDE.md §12). Never reports versions. */
@injectable()
export class HealthService {
  constructor(
    @inject(TOKENS.Database) private readonly db: IDatabase,
    @inject(TOKENS.Cache) private readonly cache: ICache,
    @inject(TOKENS.MessageBroker) private readonly broker: IMessageBroker,
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'HEALTH_CHECK_TIMEOUT_MS'>,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const [postgres, redis, rabbitmq] = await Promise.all([
      this.timed(() => this.db.ping()),
      this.timed(() => this.cache.ping()),
      this.timed(() =>
        this.broker.isConnected() ? Promise.resolve() : Promise.reject(new Error('broker not connected')),
      ),
    ]);
    const checks = {
      [Dependency.POSTGRES]: postgres,
      [Dependency.REDIS]: redis,
      [Dependency.RABBITMQ]: rabbitmq,
    };
    const allUp = Object.values(checks).every((check) => check.status === DependencyStatus.UP);
    return { status: allUp ? DependencyStatus.UP : DependencyStatus.DOWN, checks };
  }

  private async timed(check: () => Promise<void>): Promise<DependencyCheck> {
    const startedAt = this.clock.now().getTime();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CheckTimeoutError()), this.env.HEALTH_CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([check(), timeout]);
      return { status: DependencyStatus.UP, durationMs: this.clock.now().getTime() - startedAt };
    } catch {
      return { status: DependencyStatus.DOWN, durationMs: this.clock.now().getTime() - startedAt };
    } finally {
      clearTimeout(timer);
    }
  }
}
