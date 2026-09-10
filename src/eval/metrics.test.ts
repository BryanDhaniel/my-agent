import { describe, it, expect } from "vitest";
import { summarize, categoryBreakdown, compareRuns } from "./metrics.js";
import type { EvaluationRun, TaskResult } from "./types.js";

function result(over: Partial<TaskResult> & Pick<TaskResult, "id" | "category" | "status">): TaskResult {
  return {
    prompt: "",
    provider: "fake",
    model: "fake-model",
    success: over.status === "passed",
    durationMs: 100,
    llmTurns: 2,
    toolCalls: 1,
    tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    cost: { currency: "unknown" },
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function run(
  over: Partial<EvaluationRun> & Pick<EvaluationRun, "id" | "provider" | "model">,
  tasks: TaskResult[],
): EvaluationRun {
  return {
    createdAt: new Date().toISOString(),
    dryRun: false,
    tasksDir: "/tmp",
    pricingSource: "unknown",
    summary: summarize(tasks),
    categoryBreakdown: categoryBreakdown(tasks),
    tasks,
    ...over,
  };
}

describe("metrics", () => {
  const tasks = [
    result({ id: "a", category: "bug-fix", status: "passed" }),
    result({ id: "b", category: "bug-fix", status: "failed" }),
    result({ id: "c", category: "feature", status: "passed", durationMs: 200 }),
  ];

  it("summarizes success rate and totals", () => {
    const s = summarize(tasks);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.successRate).toBeCloseTo(2 / 3);
    expect(s.totalTokens).toBe(45);
  });

  it("produces a per-category breakdown", () => {
    const b = categoryBreakdown(tasks);
    expect(b["bug-fix"].total).toBe(2);
    expect(b["bug-fix"].passed).toBe(1);
    expect(b["bug-fix"].successRate).toBeCloseTo(0.5);
    expect(b.feature.total).toBe(1);
  });

  it("computes a comparison between two runs", () => {
    const baseline = run({ id: "r1", provider: "openai", model: "gpt-4o" }, [
      result({ id: "a", category: "bug-fix", status: "failed" }),
    ]);
    const candidate = run({ id: "r2", provider: "gemini", model: "gemini-2.5-flash" }, [
      result({ id: "a", category: "bug-fix", status: "passed" }),
    ]);
    const c = compareRuns(baseline, candidate);
    expect(c.successRateDelta).toBeCloseTo(1);
    expect(c.baseline.provider).toBe("openai");
    expect(c.candidate.provider).toBe("gemini");
  });
});
