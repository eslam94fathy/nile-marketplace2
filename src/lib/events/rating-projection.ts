import { ratingAverage } from '../rating';
import { type ReviewRatingChangedPayload } from './contracts';
import { type EventEnvelope } from './contracts/define-event';
import { PermanentEventError } from './event-consumer';

/** What a projection stores for one subject (spec 06 §9.2, spec 05 §8.1). */
export interface RatingProjection {
  ratingCount: number;
  /** The spec 17 §1.2 rule, so every copy rounds the same way; null without ratings. */
  ratingAvg: string | null;
  version: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Reads one subject of `review.rating_changed` (catalog: `product`, sellers: `seller`). A payload that
 * can never be applied (missing id, a count out of range) is permanent: the DLQ, not a retry.
 */
export function readRatingProjection(
  envelope: EventEnvelope,
  subject: 'product' | 'seller',
): { subjectId: string; projection: RatingProjection } {
  const payload = envelope.payload as Partial<ReviewRatingChangedPayload>;
  const part = payload[subject] as Record<string, unknown> | undefined;
  const subjectId = part?.[subject === 'product' ? 'productId' : 'sellerId'];
  const { ratingCount, ratingSum, version } = part ?? {};
  if (
    typeof subjectId !== 'string' ||
    !UUID_PATTERN.test(subjectId) ||
    !isCount(ratingCount) ||
    !isCount(ratingSum) ||
    !isCount(version) ||
    version < 1 ||
    ratingSum < ratingCount ||
    ratingSum > 5 * ratingCount
  ) {
    throw new PermanentEventError(`${envelope.eventType}: payload.${subject} is malformed`);
  }
  return {
    subjectId,
    projection: { ratingCount, ratingAvg: ratingAverage(ratingSum, ratingCount), version },
  };
}
