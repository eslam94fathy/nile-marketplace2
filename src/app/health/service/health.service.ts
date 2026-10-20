import { inject, injectable } from 'tsyringe';
import { type IClock } from '../../../lib/clock';
import { type Env } from '../../../lib/config';
import { TOKENS } from '../../../lib/di';
import { type Dependency, DependencyStatus } from '../enums';

export interface DependencyCheck {
  status: DependencyStatus;
  durationMs: number;
}

export interface ReadinessReport {
  status: DependencyStatus;
  checks: Partial<Record<Dependency, DependencyCheck>>;
}

/**
 * One dependency the process needs. Each process registers its own list (`TOKENS.HealthChecks`): the
 * api checks Postgres, Redis, RabbitMQ and storage; the realtime gateway Postgres and Redis (spec 15).
 */
export interface HealthCheck {
  dependency: Dependency;
  /** Resolves when the dependency answers; rejects otherwise. */
  check(): Promise<void>;
}

class CheckTimeoutError extends Error {
  override readonly name = 'CheckTimeoutError';
}

/** Readiness checks every dependency, each with its own timeout (CLAUDE.md §12). Never reports versions. */
@injectable()
export class HealthService {
  constructor(
    @inject(TOKENS.HealthChecks) private readonly dependencies: readonly HealthCheck[],
    @inject(TOKENS.Env) private readonly env: Pick<Env, 'HEALTH_CHECK_TIMEOUT_MS'>,
    @inject(TOKENS.Clock) private readonly clock: IClock,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.dependencies.map(async (item) => [item.dependency, await this.timed(() => item.check())] as const),
    );
    const checks = Object.fromEntries(results) as Partial<Record<Dependency, DependencyCheck>>;
    const allUp = results.every(([, result]) => result.status === DependencyStatus.UP);
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
