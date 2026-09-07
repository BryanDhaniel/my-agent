/**
 * Normalized error classification.
 *
 * Retry and reporting decisions must not depend on ad-hoc string matching
 * scattered through the codebase, so every failure is classified once, here,
 * into an `AgentError` carrying a stable kind and a retryability verdict.
 */

export type AgentErrorKind =
  | "authentication"
  | "rate_limit"
  | "invalid_request"
  | "model_unavailable"
  | "network"
  | "provider"
  | "tool"
  | "permission"
  | "timeout"
  | "cancellation"
  | "configuration"
  | "context"
  | "internal";

export interface AgentErrorOptions {
  kind: AgentErrorKind;
  message: string;
  retryable?: boolean;
  cause?: unknown;
  status?: number;
}

export class AgentError extends Error {
  readonly kind: AgentErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;
  override readonly cause: unknown;

  constructor(options: AgentErrorOptions) {
    super(options.message);
    this.name = "AgentError";
    this.kind = options.kind;
    this.retryable = options.retryable ?? RETRYABLE_KINDS.has(options.kind);
    this.status = options.status;
    this.cause = options.cause;
  }
}

/** Kinds that are worth another attempt; everything else fails immediately. */
const RETRYABLE_KINDS = new Set<AgentErrorKind>([
  "rate_limit",
  "network",
  "model_unavailable",
  "timeout",
]);

interface Rule {
  kind: AgentErrorKind;
  pattern: RegExp;
  retryable?: boolean;
}

/**
 * Ordered: the first match wins, so specific failures (auth) are checked
 * before broad ones (network / 5xx).
 */
const RULES: Rule[] = [
  { kind: "cancellation", pattern: /abort|cancel|aborted by user|signal is aborted/i, retryable: false },
  { kind: "authentication", pattern: /401|403|unauthoriz|forbidden|invalid api key|authentication/i, retryable: false },
  { kind: "rate_limit", pattern: /rate.?limit|429|too many requests|quota exceeded/i, retryable: true },
  { kind: "timeout", pattern: /timed? ?out|timeout|deadline exceeded|etimedout/i, retryable: true },
  { kind: "permission", pattern: /permission denied|not permitted|denied by policy/i, retryable: false },
  { kind: "invalid_request", pattern: /400|invalid request|invalid arguments|bad request|validation/i, retryable: false },
  {
    kind: "model_unavailable",
    pattern:
      /404|model.*(not found|unavailable)|overloaded|503|service unavailable|capacity|temporarily|temporary|unavailable/i,
    retryable: true,
  },
  { kind: "network", pattern: /econnreset|econnrefused|enotfound|eai_again|socket hang up|fetch failed|network|dns/i, retryable: true },
  { kind: "tool", pattern: /unknown tool|tool .*failed|invalid arguments/i, retryable: false },
  { kind: "configuration", pattern: /missing api key|unknown provider|unknown role|missing a task|depth limit|maxConcurrency/i, retryable: false },
  { kind: "context", pattern: /context|token budget|compaction/i, retryable: false },
];

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const status = (error as Record<string, unknown>)["status"];
    if (typeof status === "number") return status;
    const code = (error as Record<string, unknown>)["code"];
    if (typeof code === "number") return code;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** Classify anything thrown into a stable AgentError. */
export function classifyError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;

  const message = messageOf(error);
  const status = statusOf(error);

  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return new AgentError({ kind: "authentication", message, status, cause: error });
    }
    if (status === 429) {
      return new AgentError({ kind: "rate_limit", message, status, cause: error });
    }
    if (status === 404 || status === 503) {
      return new AgentError({ kind: "model_unavailable", message, status, cause: error });
    }
    if (status >= 500) {
      return new AgentError({ kind: "network", message, status, cause: error });
    }
    if (status >= 400) {
      return new AgentError({ kind: "invalid_request", message, status, cause: error });
    }
  }

  for (const rule of RULES) {
    if (rule.pattern.test(message)) {
      return new AgentError({
        kind: rule.kind,
        message,
        ...(rule.retryable !== undefined ? { retryable: rule.retryable } : {}),
        cause: error,
      });
    }
  }

  return new AgentError({ kind: "internal", message, cause: error });
}

/** Retry verdict for an arbitrary thrown value. */
export function isRetryableError(error: unknown): boolean {
  return classifyError(error).retryable;
}

/** True when the failure was a deliberate abort rather than a real fault. */
export function isCancellation(error: unknown): boolean {
  return classifyError(error).kind === "cancellation";
}
