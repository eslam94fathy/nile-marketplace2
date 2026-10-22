/** A browser's push subscription (W3C Push API `PushSubscription.toJSON()`). */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

export interface PushMessage {
  /** Encrypted per RFC 8291 before it leaves the process. */
  payload: string;
  /** How long the push service keeps it for an offline device. */
  ttlSeconds: number;
  urgency: PushUrgency;
}

/**
 * What a send means for the subscription (spec 13 UC-NO-3 step 3):
 * - `delivered`: the push service accepted it (201)
 * - `gone`: the subscription no longer exists (404, 410): delete it
 * - `rejected`: the push service will never accept this request (400, 413, other 4xx): don't retry
 * - `transient`: timeout, network error, 429 or 5xx: retry later
 */
export type PushOutcome = 'delivered' | 'gone' | 'rejected' | 'transient';

export interface PushResult {
  outcome: PushOutcome;
  /** The push service's status code; absent when no response came back. */
  statusCode?: number;
}

/** Sends one Web Push message (RFC 8030, VAPID RFC 8292). Never throws: failures are an outcome. */
export interface IPushSender {
  send(target: PushTarget, message: PushMessage): Promise<PushResult>;
}

const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR = 500;

/** Maps a push service status code to an outcome (spec 13 UC-NO-3 step 3). */
export function outcomeOf(statusCode: number): PushOutcome {
  if (statusCode >= 200 && statusCode < 300) return 'delivered';
  if (statusCode === 404 || statusCode === 410) return 'gone';
  if (statusCode === TOO_MANY_REQUESTS || statusCode >= SERVER_ERROR) return 'transient';
  return 'rejected';
}
