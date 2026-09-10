import type {
  CategoryMetric,
  EvaluationRun,
  RunSummary,
  TaskCategory,
  TaskResult,
} from "./types.js";
import { TASK_CATEGORIES } from "./types.js";

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function sumTokens(results: readonly TaskResult[], key: keyof TaskResult["tokens"]): number {
  let total = 0;
  for (const r of results) {
    const v = r.tokens[key];
    if (typeof v === "number") total += v;
  }
  return total;
}

function aggregateCost(results: readonly TaskResult[]): number | undefined {
  const defined = results
    .map((r) => r.cost.totalCost)
    .filter((c): c is number => typeof c === "number");
  if (defined.length === 0) return undefined;
  return defined.reduce((sum, c) => sum + c, 0);
}

/** Aggregate a flat list of task results into the run-level summary. */
export function summarize(results: readonly TaskResult[]): RunSummary {
  const total = results.length;
  const passed = results.filter((r) => r.success).length;
  return {
    total,
    passed,
    failed: total - passed,
    successRate: total === 0 ? 0 : passed / total,
    avgDurationMs: average(results.map((r) => r.durationMs)),
    avgLlmTurns: average(results.map((r) => r.llmTurns)),
    avgToolCalls: average(results.map((r) => r.toolCalls)),
    totalInputTokens: sumTokens(results, "inputTokens"),
    totalOutputTokens: sumTokens(results, "outputTokens"),
    totalTokens: sumTokens(results, "totalTokens"),
    costCurrency: results[0]?.cost.currency ?? "unknown",
    totalCost: aggregateCost(results),
  };
}

function metricFor(category: TaskCategory, results: readonly TaskResult[]): CategoryMetric {
  const subset = results.filter((r) => r.category === category);
  const total = subset.length;
  const passed = subset.filter((r) => r.success).length;
  return {
    total,
    passed,
    successRate: total === 0 ? 0 : passed / total,
    avgDurationMs: average(subset.map((r) => r.durationMs)),
    avgLlmTurns: average(subset.map((r) => r.llmTurns)),
    avgToolCalls: average(subset.map((r) => r.toolCalls)),
    totalInputTokens: sumTokens(subset, "inputTokens"),
    totalOutputTokens: sumTokens(subset, "outputTokens"),
    totalTokens: sumTokens(subset, "totalTokens"),
    costCurrency: subset[0]?.cost.currency ?? "unknown",
    totalCost: aggregateCost(subset),
  };
}

/** Per-category breakdown so regressions can be localised to a category. */
export function categoryBreakdown(
  results: readonly TaskResult[],
): Record<TaskCategory, CategoryMetric> {
  const out = {} as Record<TaskCategory, CategoryMetric>;
  for (const category of TASK_CATEGORIES) {
    out[category] = metricFor(category, results);
  }
  return out;
}

/** Difference between two runs, used by `--compare-runs`. */
export interface RunComparison {
  baseline: { id: string; provider: string; model: string; successRate: number; avgDurationMs: number; totalTokens: number; totalCost?: number };
  candidate: { id: string; provider: string; model: string; successRate: number; avgDurationMs: number; totalTokens: number; totalCost?: number };
  successRateDelta: number;
  avgDurationMsDelta: number;
  totalTokensDelta: number;
  totalCostDelta?: number;
}

export function compareRuns(baseline: EvaluationRun, candidate: EvaluationRun): RunComparison {
  return {
    baseline: {
      id: baseline.id,
      provider: baseline.provider,
      model: baseline.model,
      successRate: baseline.summary.successRate,
      avgDurationMs: baseline.summary.avgDurationMs,
      totalTokens: baseline.summary.totalTokens,
      ...(baseline.summary.totalCost !== undefined ? { totalCost: baseline.summary.totalCost } : {}),
    },
    candidate: {
      id: candidate.id,
      provider: candidate.provider,
      model: candidate.model,
      successRate: candidate.summary.successRate,
      avgDurationMs: candidate.summary.avgDurationMs,
      totalTokens: candidate.summary.totalTokens,
      ...(candidate.summary.totalCost !== undefined
        ? { totalCost: candidate.summary.totalCost }
        : {}),
    },
    successRateDelta: candidate.summary.successRate - baseline.summary.successRate,
    avgDurationMsDelta: candidate.summary.avgDurationMs - baseline.summary.avgDurationMs,
    totalTokensDelta: candidate.summary.totalTokens - baseline.summary.totalTokens,
    ...(baseline.summary.totalCost !== undefined && candidate.summary.totalCost !== undefined
      ? { totalCostDelta: candidate.summary.totalCost - baseline.summary.totalCost }
      : {}),
  };
}
