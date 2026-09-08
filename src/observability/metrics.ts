/**
 * In-process metrics.
 *
 * Deliberately local: no Prometheus, no external service. The interface is
 * small enough that an OpenTelemetry or Prometheus exporter can be added
 * later without touching call sites.
 */

export interface Metrics {
  increment(name: string, value?: number): void;
  observe(name: string, value: number): void;
  set(name: string, value: number): void;
}

/** Metric names, so call sites do not invent spellings. */
export const METRIC = {
  agentRunsTotal: "agent_runs_total",
  agentRunsSuccess: "agent_runs_success",
  agentRunsFailed: "agent_runs_failed",
  agentRunsCancelled: "agent_runs_cancelled",
  agentRunDurationMs: "agent_run_duration_ms",

  llmRequestsTotal: "llm_requests_total",
  llmRequestsFailed: "llm_requests_failed",
  llmRequestDurationMs: "llm_request_duration_ms",
  llmInputTokens: "llm_input_tokens",
  llmOutputTokens: "llm_output_tokens",
  llmTotalTokens: "llm_total_tokens",

  toolCallsTotal: "tool_calls_total",
  toolCallsFailed: "tool_calls_failed",
  toolCallDurationMs: "tool_call_duration_ms",
  toolCallsDenied: "tool_calls_denied",

  subagentRunsTotal: "subagent_runs_total",
  subagentRunsFailed: "subagent_runs_failed",
  subagentDurationMs: "subagent_duration_ms",

  tasksTotal: "tasks_total",
  tasksCompleted: "tasks_completed",
  tasksFailed: "tasks_failed",
  tasksCancelled: "tasks_cancelled",
  tasksSkipped: "tasks_skipped",
  tasksRetried: "tasks_retried",
  taskDurationMs: "task_duration_ms",

  retriesTotal: "retries_total",
  timeoutsTotal: "timeouts_total",
  cancellationsTotal: "cancellations_total",

  securityChecksTotal: "security_checks_total",
  securityDenialsTotal: "security_denials_total",
  permissionRequestsTotal: "permission_requests_total",
  dangerousCommandsBlockedTotal: "dangerous_commands_blocked_total",
  pathTraversalsBlockedTotal: "path_traversals_blocked_total",
  secretAccessBlockedTotal: "secret_access_blocked_total",
} as const;

export interface ObservationStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  observations: Record<string, ObservationStats>;
}

export class MetricsCollector implements Metrics {
  #counters = new Map<string, number>();
  #gauges = new Map<string, number>();
  #observations = new Map<string, number[]>();

  increment(name: string, value = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + value);
  }

  observe(name: string, value: number): void {
    const values = this.#observations.get(name) ?? [];
    // Bounded: a long run must not grow memory without limit.
    if (values.length >= 1_000) values.shift();
    values.push(value);
    this.#observations.set(name, values);
  }

  set(name: string, value: number): void {
    this.#gauges.set(name, value);
  }

  counter(name: string): number {
    return this.#counters.get(name) ?? 0;
  }

  gauge(name: string): number | undefined {
    return this.#gauges.get(name);
  }

  stats(name: string): ObservationStats | undefined {
    const values = this.#observations.get(name);
    if (values === undefined || values.length === 0) return undefined;
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      count: values.length,
      sum,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: sum / values.length,
    };
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [key, value] of this.#counters) counters[key] = value;

    const gauges: Record<string, number> = {};
    for (const [key, value] of this.#gauges) gauges[key] = value;

    const observations: Record<string, ObservationStats> = {};
    for (const key of this.#observations.keys()) {
      const stats = this.stats(key);
      if (stats !== undefined) observations[key] = stats;
    }

    return { counters, gauges, observations };
  }

  reset(): void {
    this.#counters.clear();
    this.#gauges.clear();
    this.#observations.clear();
  }
}
