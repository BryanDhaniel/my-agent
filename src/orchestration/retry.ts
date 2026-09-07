/**
 * Retry policy.
 *
 * Kept in one place rather than scattered through the scheduler: only
 * transient failures are retried, and configuration or permission problems
 * fail immediately.
 */

const TRANSIENT =
  /rate.?limit|429|500|502|503|504|timeout|timed out|temporarily|temporary|unavailable|overloaded|econnreset|econnrefused|etimedout|network|socket hang up|fetch failed/i;

/** Never worth another attempt — the same input would fail identically. */
const PERMANENT =
  /permission denied|invalid|unknown (tool|role|provider|skill)|depth limit|missing (a task|API key)|not available to sub-agents/i;

export function isRetryableError(message: string): boolean {
  if (PERMANENT.test(message)) return false;
  return TRANSIENT.test(message);
}

/** Exponential backoff with a ceiling, so a bad hour cannot stall a plan. */
export function backoffMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 8_000);
}

/**
 * Sleep that must not outlive cancellation: resolves early when the signal
 * aborts so a retry wait never blocks shutdown.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
