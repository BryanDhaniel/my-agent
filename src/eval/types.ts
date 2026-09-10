import type { Provider } from "../providers/provider.js";
import type { Observability, PricingRegistry } from "../observability/index.js";
import type { TokenUsage, UsageCost } from "../observability/usage.js";

/**
 * Evaluation domain types.
 *
 * The evaluation system drives the *real* AgentHarness — it never re-implements
 * an agent. These types describe the curated tasks, the per-task results, and
 * the aggregated run report. Token usage and cost come from the harness's
 * observability sink; when pricing is not configured, cost is reported as
 * "unknown" rather than invented.
 */

export type TaskCategory =
  | "bug-fix"
  | "feature"
  | "refactor"
  | "testing"
  | "debugging";

export const TASK_CATEGORIES: readonly TaskCategory[] = [
  "bug-fix",
  "feature",
  "refactor",
  "testing",
  "debugging",
];

/** Command run after the agent finishes; exit code 0 means pass. */
export interface ValidationSpec {
  command: string;
  /** Working directory for the command, relative to the isolated fixture root. */
  cwd?: string;
  /** Hard timeout in milliseconds (default 60_000). */
  timeoutMs?: number;
}

/** A curated, deterministic task loaded from `evals/tasks/<id>/task.json`. */
export interface EvaluationTask {
  id: string;
  category: TaskCategory;
  /** The prompt handed to the agent verbatim. */
  prompt: string;
  /** Subdirectory of the task holding the fixture (default "fixture"). */
  fixture?: string;
  /** Per-task turn cap (falls back to the runner default). */
  maxTurns?: number;
  validation: ValidationSpec;
  /** Human notes; never read by the runner. */
  notes?: string;
}

export type TaskStatus = "passed" | "failed" | "error" | "timeout" | "skipped";

export interface TaskResult {
  id: string;
  category: TaskCategory;
  prompt: string;
  status: TaskStatus;
  /** Validation-as-success: status === "passed" ⇒ success is true. */
  success: boolean;
  provider: string;
  model: string;
  durationMs: number;
  llmTurns: number;
  toolCalls: number;
  tokens: TokenUsage;
  /** Currency "unknown" when pricing is not configured. */
  cost: UsageCost;
  validationExitCode?: number;
  error?: string;
  createdAt: string;
}

export interface CategoryMetric {
  total: number;
  passed: number;
  successRate: number;
  avgDurationMs: number;
  avgLlmTurns: number;
  avgToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  costCurrency: string;
  totalCost?: number;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  successRate: number;
  avgDurationMs: number;
  avgLlmTurns: number;
  avgToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  costCurrency: string;
  totalCost?: number;
}

export interface EvaluationRun {
  id: string;
  createdAt: string;
  provider: string;
  model: string;
  commitSha?: string;
  dryRun: boolean;
  tasksDir: string;
  /** "configured" when a pricing registry was supplied, else "unknown". */
  pricingSource: "configured" | "unknown";
  summary: RunSummary;
  categoryBreakdown: Record<TaskCategory, CategoryMetric>;
  tasks: TaskResult[];
}

export interface RunnerOptions {
  provider: string;
  model: string;
  /** API key. Ignored when `providerOverride` is supplied (tests). */
  apiKey?: string;
  tasksDir: string;
  resultsDir: string;
  /** Inject a provider directly (tests). When set, `apiKey` is ignored. */
  providerOverride?: Provider;
  /** Observability sink for token capture; a fresh one is created if omitted. */
  observability?: Observability;
  /** Pricing registry; empty ⇒ cost reported "unknown". */
  pricing?: PricingRegistry;
  /** Default turn cap per task (task.maxTurns overrides). */
  maxTurns?: number;
  validationTimeoutMs?: number;
  dryRun?: boolean;
  commitSha?: string;
}
