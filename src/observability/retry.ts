import { classifyError } from "./errors.js";

/**
 * The single retry policy.
 *
 * Backoff lives here so the orchestrator and provider paths share one
 * implementation rather than growing competing loops. Retryability comes
 * from `classifyError`, not from string matching at the call site.
 */

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;

/**
 * Bounded exponential backoff. Deterministic on purpose (tests assert it);
 * jitter is applied by `withRetry` when actually scheduling the wait.
 */
export function backoffMs(attempt: number, baseMs = BASE_DELAY_MS): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
}

/** Sleep that resolves early on abort, so a retry wait never blocks shutdown. */
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

export interface RetryPolicy {
  maxRetries: number;
  shouldRetry(error: unknown): boolean;
  getDelay(attempt: number): number;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxRetries: 3,
  shouldRetry: (error) => classifyError(error).retryable,
  getDelay: (attempt) => backoffMs(attempt),
};

export interface WithRetryOptions {
  policy?: RetryPolicy;
  signal?: AbortSignal;
  /** Called before each wait, so every recovery is observable. */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    error: ReturnType<typeof classifyError>;
  }) => void;
  /** Spread to avoid synchronised retries across parallel sub-agents. */
  jitterMs?: number;
}

export class RetryBudgetExceededError extends Error {
  constructor(attempts: number, cause: unknown) {
    super(`retry budget exhausted after ${attempts} attempts`);
    this.name = "RetryBudgetExceededError";
    this.cause = cause;
  }
}

/**
 * Runs `operation` with bounded retries.
 *
 * Never retries a non-retryable failure, never retries past the budget, and
 * aborts immediately (without waiting out a backoff) when cancelled.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? defaultRetryPolicy;
  const jitter = options.jitterMs ?? 250;

  for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      const classified = classifyError(error);
      const lastAttempt = attempt > policy.maxRetries;

      if (lastAttempt || !policy.shouldRetry(error) || (options.signal?.aborted ?? false)) {
        throw error;
      }

      const waitMs = policy.getDelay(attempt) + Math.floor(Math.random() * jitter);
      options.onRetry?.({ attempt: attempt + 1, delayMs: waitMs, error: classified });
      await delay(waitMs, options.signal);

      if (options.signal?.aborted === true) throw error;
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new RetryBudgetExceededError(policy.maxRetries + 1, undefined);
}
