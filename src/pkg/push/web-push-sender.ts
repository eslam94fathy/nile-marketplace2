import webPush, { WebPushError } from 'web-push';
import {
  outcomeOf,
  type IPushSender,
  type PushMessage,
  type PushResult,
  type PushTarget,
} from './push-sender.interface';

export interface WebPushOptions {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  /** `mailto:` or `https:` contact the push services can reach (RFC 8292). */
  vapidSubject: string;
  /** The whole request, not just socket inactivity (the library's own timeout is the latter). */
  timeoutMs: number;
}

class PushTimeoutError extends Error {
  override readonly name = 'PushTimeoutError';
}

/** Standard Web Push through the `web-push` library (R-20): VAPID-signed, RFC 8291 encrypted. */
export class WebPushSender implements IPushSender {
  constructor(private readonly options: WebPushOptions) {}

  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PushTimeoutError()), this.options.timeoutMs);
    });
    try {
      const response = await Promise.race([
        webPush.sendNotification(target, message.payload, {
          vapidDetails: {
            subject: this.options.vapidSubject,
            publicKey: this.options.vapidPublicKey,
            privateKey: this.options.vapidPrivateKey,
          },
          TTL: message.ttlSeconds,
          urgency: message.urgency,
          timeout: this.options.timeoutMs,
          contentEncoding: 'aes128gcm',
        }),
        deadline,
      ]);
      return { outcome: outcomeOf(response.statusCode), statusCode: response.statusCode };
    } catch (error) {
      // A non-2xx answer: the library throws it with the status. Anything else never got an answer.
      if (error instanceof WebPushError) {
        return { outcome: outcomeOf(error.statusCode), statusCode: error.statusCode };
      }
      return { outcome: 'transient' };
    } finally {
      clearTimeout(timer);
    }
  }
}
