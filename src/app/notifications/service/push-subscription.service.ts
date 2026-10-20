import { inject, injectable } from 'tsyringe';
import { type Env } from '../../../lib/config';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { isAllowedPushEndpoint } from '../../../pkg/push';
import { MAX_PUSH_SUBSCRIPTIONS_PER_USER } from '../constants';
import { pushEndpointNotAllowed } from '../errors';
import {
  type NewPushSubscription,
  type PushSubscriptionRepository,
} from '../repository/push-subscription.repository';

type PushApiEnv = Pick<Env, 'VAPID_PUBLIC_KEY' | 'PUSH_ENDPOINT_HOST_ALLOWLIST'>;

/** The caller's browsers for Web Push (spec 13 UC-NO-4, §8.4). */
@injectable()
export class PushSubscriptionService {
  constructor(
    @inject(TOKENS.PushSubscriptionRepository) private readonly subscriptions: PushSubscriptionRepository,
    @inject(TOKENS.TransactionRunner) private readonly transactions: ITransactionRunner,
    @inject(TOKENS.Env) private readonly env: PushApiEnv,
  ) {}

  /** What the browser's `pushManager.subscribe({ applicationServerKey })` needs. */
  vapidPublicKey(): string {
    return this.env.VAPID_PUBLIC_KEY;
  }

  /**
   * Upsert by endpoint (a browser that switched accounts moves to this user), then keep the user's
   * newest 10. PUSH_ENDPOINT_NOT_ALLOWED for a host outside the allow-list (SSRF guard).
   */
  async register(subscription: NewPushSubscription): Promise<void> {
    if (!isAllowedPushEndpoint(subscription.endpoint, this.env.PUSH_ENDPOINT_HOST_ALLOWLIST)) {
      throw pushEndpointNotAllowed();
    }
    await this.transactions.run(async (trx) => {
      await this.subscriptions.lockUser(subscription.userId, trx);
      await this.subscriptions.upsert(subscription, trx);
      await this.subscriptions.trimToNewest(subscription.userId, MAX_PUSH_SUBSCRIPTIONS_PER_USER, trx);
    });
  }

  /** Before logout. An unknown endpoint, or another user's, is a quiet no-op. */
  unregister(userId: string, endpoint: string): Promise<void> {
    return this.subscriptions.deleteForUser(userId, endpoint);
  }
}
