import { toMs, TimeUnit } from '../../pkg/time';

/** Socket.IO `path` (spec 15 UC-RT-1); the ALB routes `/realtime*` here (A-7). */
export const REALTIME_PATH = '/realtime';

/** Worker consumer (spec 15 UC-RT-2, §5). */
export const REALTIME_FANOUT_QUEUE = 'realtime.fanout';

/** Inbound frame cap (spec 15 §3.3): signals are a few ids. */
export const MAX_INBOUND_BYTES = 4 * 1024;

/** The signal rate limit counts per second (RT-5). */
export const SIGNAL_WINDOW_MS = toMs(1, TimeUnit.SECOND);

/** setTimeout's ceiling; access tokens live far shorter (15 min), so this never truncates in practice. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** UC-RT-4: how long close() waits for the `session.ended` frames to flush before closing the server. */
export const SHUTDOWN_SOCKET_DRAIN_MS = toMs(1, TimeUnit.SECOND);

/** Redis key prefix of the handshake limiter (rate class `realtime-connect`). */
export const CONNECT_RATE_LIMIT_KEY_PREFIX = 'rl:realtime-connect';

/*
 * Status values realtime sends but whose enums belong to modules it may not import (payments, delivery,
 * media; architecture §14.2). They mirror those enums; a unit test keeps them equal.
 */
export const PaymentStatusValue = { PAID: 'paid', FAILED: 'failed', EXPIRED: 'expired' } as const;
export const ShipmentStatusValue = {
  PICKED_UP: 'picked_up',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERY_FAILED: 'delivery_failed',
  RETURNING_TO_SELLER: 'returning_to_seller',
  DELIVERED: 'delivered',
} as const;
export const MediaStatusValue = { READY: 'ready', FAILED: 'failed' } as const;
