/**
 * Retry primitives used by the orchestrator.
 *
 * These are re-exported from the single canonical implementation in
 * `src/observability/retry.ts`, so backoff and cancellation behaviour cannot
 * drift between the orchestrator and the rest of the runtime, and retryability
 * comes from classified errors rather than local string matching.
 */

export {
  backoffMs,
  delay,
  defaultRetryPolicy,
  withRetry,
  type RetryPolicy,
} from "../observability/retry.js";

export { isRetryableError } from "../observability/errors.js";
