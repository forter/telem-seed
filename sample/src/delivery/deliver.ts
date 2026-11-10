import { randomUUID } from 'crypto';
import { logAttempt } from '../db/deliveryLog';
import type { Subscriber } from '../db/subscribers';

const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '6', 10));
// Exponential backoff: 1 s, 2 s, 4 s, … capped at 30 s per gap.
const RETRY_DELAYS = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) =>
  Math.min(1000 * 2 ** i, 30_000)
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deliver(
  subscriber: Subscriber,
  topic: string,
  messageKey: string | null,
  payload: string
): Promise<void> {
  // One UUID per delivery attempt sequence — acts as an idempotency key for the receiver.
  const deliveryId = randomUUID();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let httpStatus: number | null = null;
    let errorMessage: string | null = null;
    let success = false;

    try {
      const response = await fetch(subscriber.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Delivery-Id': deliveryId,
          // Spread per-subscriber custom headers on top of the defaults.
          ...subscriber.headers,
        },
        body: payload,
      });

      httpStatus = response.status;
      success = response.ok; // 2xx

      if (!success) {
        errorMessage = `HTTP ${response.status} ${response.statusText}`;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    if (success) {
      await logAttempt({
        subscriber_id: subscriber.id,
        message_key: messageKey,
        payload,
        attempt_number: attempt,
        status: 'success',
        http_status: httpStatus,
        error_message: null,
      });
      return; // Done — no further retries needed.
    }

    // Log the failed attempt.
    const isLastAttempt = attempt === MAX_ATTEMPTS;
    await logAttempt({
      subscriber_id: subscriber.id,
      message_key: messageKey,
      payload,
      attempt_number: attempt,
      status: isLastAttempt ? 'exhausted' : 'failed',
      http_status: httpStatus,
      error_message: errorMessage,
    });

    if (!isLastAttempt) {
      await sleep(RETRY_DELAYS[attempt - 1]);
    }
  }
}
