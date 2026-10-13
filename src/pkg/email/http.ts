import { EmailSendError } from './email-sender.interface';

const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;

/**
 * POSTs JSON with a timeout and classifies failures:
 * 400/422 → permanent (the message itself is bad); anything else (401/403 config, 429, 5xx,
 * timeout, network) → transient, so the broker retries and the DLQ keeps the message for replay.
 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new EmailSendError('email provider unreachable', false, null, { cause });
  }

  const text = await response.text();
  if (!response.ok) {
    const permanent = response.status === HTTP_BAD_REQUEST || response.status === HTTP_UNPROCESSABLE;
    // The provider's error body helps debugging; it never contains our credentials.
    throw new EmailSendError(
      `email provider responded ${response.status}: ${text.slice(0, 500)}`,
      permanent,
      response.status,
    );
  }
  try {
    return text.length > 0 ? (JSON.parse(text) as unknown) : {};
  } catch (cause) {
    throw new EmailSendError('email provider returned invalid JSON', false, response.status, { cause });
  }
}
