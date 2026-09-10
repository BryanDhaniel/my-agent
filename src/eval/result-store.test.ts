import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvaluationResultStore } from "./result-store.js";
import { summarize, categoryBreakdown } from "./metrics.js";
import type { EvaluationRun, TaskResult } from "./types.js";

let dir: string;
let store: EvaluationResultStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eval-store-"));
  store = new EvaluationResultStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeRun(
  id: string,
  passed: number,
  total: number,
  createdAt: string = new Date().toISOString(),
  commitSha?: string,
): EvaluationRun {
  const tasks: TaskResult[] = Array.from({ length: total }, (_, i) => ({
    id: `t${i}`,
    category: "bug-fix",
    prompt: "",
    provider: "fake",
    model: "fake-model",
    status: i < passed ? "passed" : "failed",
    success: i < passed,
    durationMs: 10,
    llmTurns: 1,
    toolCalls: 0,
    tokens: {},
    cost: { currency: "unknown" },
    createdAt: new Date().toISOString(),
  }));
  return {
    id,
    createdAt,
    provider: "fake",
    model: "fake-model",
    dryRun: false,
    tasksDir: "/tmp",
    pricingSource: "unknown",
    summary: summarize(tasks),
    categoryBreakdown: categoryBreakdown(tasks),
    tasks,
    ...(commitSha !== undefined ? { commitSha } : {}),
  };
}

describe("EvaluationResultStore", () => {
  it("saves and loads a run by id", async () => {
    const run = makeRun("run-a", 2, 3);
    const path = await store.save(run);
    expect(path).toContain("run-a.json");
    const loaded = await store.load("run-a");
    expect(loaded?.summary.passed).toBe(2);
    expect(loaded?.summary.total).toBe(3);
  });

  it("lists stored runs newest-first and reports pass counts", async () => {
    // Deliberately use UUID-style ids that are NOT in chronological lexical
    // order, so a lexical filename sort would produce the WRONG order. Correct
    // ordering can only come from sorting by the createdAt timestamp.
    const oldest = "2026-01-01T00:00:00.000Z";
    const middle = "2026-06-01T00:00:00.000Z";
    const newest = "2026-09-10T00:00:00.000Z";
    await store.save(makeRun("run-zzzz", 2, 3, oldest));
    await store.save(makeRun("run-aaaa", 1, 1, newest, "abc123")); // newest
    await store.save(makeRun("run-mmmm", 0, 3, middle));
    const list = await store.list();
    expect(list[0]!.id).toBe("run-aaaa"); // newest first by createdAt
    expect(list[1]!.id).toBe("run-mmmm");
    expect(list[2]!.id).toBe("run-zzzz");
    expect(list.find((r) => r.id === "run-aaaa")?.commitSha).toBe("abc123");
    expect(list.find((r) => r.id === "run-zzzz")?.passed).toBe(2);
  });

  it("returns undefined for a missing run", async () => {
    expect(await store.load("nope")).toBeUndefined();
    expect(await store.latest()).toBeUndefined();
  });

  it("returns the chronologically newest run as latest", async () => {
    // `run-zzzz` sorts last lexically, so a lexical approach would wrongly pick
    // it as newest; the newest by createdAt is `run-aaaa`.
    await store.save(makeRun("run-zzzz", 2, 3, "2026-01-01T00:00:00.000Z"));
    await store.save(makeRun("run-aaaa", 1, 1, "2026-09-10T00:00:00.000Z"));
    const latest = await store.latest();
    expect(latest?.id).toBe("run-aaaa");
  });

  it("compares two stored runs without API calls", async () => {
    await store.save(makeRun("run-a", 0, 2));
    await store.save(makeRun("run-b", 2, 2));
    const { baseline, candidate, comparison } = await store.compare(["run-a", "run-b"]);
    expect(baseline?.id).toBe("run-a");
    expect(candidate?.id).toBe("run-b");
    expect(comparison?.successRateDelta).toBeCloseTo(1);
  });
});
