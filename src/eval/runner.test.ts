import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { EvaluationRunner } from "./runner.js";
import { FakeProvider, type FakeStep } from "./test/fake-provider.js";
import { buildPricingRegistry } from "./pricing.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "test", "fixtures");

let resultsDir: string;

beforeEach(async () => {
  resultsDir = await mkdtemp(join(tmpdir(), "eval-runner-"));
});

afterEach(async () => {
  await rm(resultsDir, { recursive: true, force: true });
});

describe("EvaluationRunner (real AgentHarness, no API)", () => {
  it("runs a passing fixture through the harness and reports success", async () => {
    const provider = new FakeProvider({
      model: "gpt-4o-mini",
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      plan: [
        { tool: { name: "run_bash", args: JSON.stringify({ command: "echo hi" }) } },
        { answer: "verified" },
      ],
    });

    const runner = new EvaluationRunner({
      provider: "fake",
      model: "gpt-4o-mini",
      tasksDir: FIXTURES,
      resultsDir,
      providerOverride: provider,
      pricing: buildPricingRegistry("builtin"),
    });

    const run = await runner.run(["passing"]);
    expect(run.tasks).toHaveLength(1);
    const task = run.tasks[0]!;
    expect(task.status).toBe("passed");
    expect(task.success).toBe(true);
    expect(task.llmTurns).toBe(2);
    expect(task.toolCalls).toBe(1);
    // Provider-authoritative tokens flow into the result via observability.
    expect(task.tokens.totalTokens).toBe(140);
    // Builtin pricing makes cost estimable rather than unknown.
    expect(task.cost.currency).toBe("USD");
    expect(task.cost.totalCost).toBeGreaterThan(0);
  });

  it("reports failure when the agent cannot fix a broken fixture", async () => {
    const provider = new FakeProvider({
      model: "fake-model",
      plan: [{ answer: "I cannot fix this" }],
    });
    const runner = new EvaluationRunner({
      provider: "fake",
      model: "fake-model",
      tasksDir: FIXTURES,
      resultsDir,
      providerOverride: provider,
    });
    const run = await runner.run(["broken"]);
    const task = run.tasks[0]!;
    expect(task.status).toBe("failed");
    expect(task.success).toBe(false);
    expect(task.validationExitCode).not.toBe(0);
  });

  it("reports failure when the provider stream fails", async () => {
    const provider = new FakeProvider({
      model: "fake-model",
      plan: [{ error: "upstream boom" }],
    });
    const runner = new EvaluationRunner({
      provider: "fake",
      model: "fake-model",
      tasksDir: FIXTURES,
      resultsDir,
      providerOverride: provider,
    });
    const run = await runner.run(["passing"]);
    // A provider stream error degrades to a failed task (the harness surfaces it
    // as agent-failed). The "error" status is reserved for unexpected exceptions
    // thrown by the harness itself, e.g. fixture setup failures.
    expect(run.tasks[0]!.status).toBe("failed");
    expect(run.tasks[0]!.error).toContain("upstream boom");
  });

  it("makes no provider calls and skips tasks in dry-run", async () => {
    const provider = new FakeProvider({ model: "fake-model", plan: [{ answer: "x" }] });
    const runner = new EvaluationRunner({
      provider: "fake",
      model: "fake-model",
      tasksDir: FIXTURES,
      resultsDir,
      providerOverride: provider,
      dryRun: true,
    });
    const run = await runner.run([]); // all tasks
    expect(provider.calls).toBe(0);
    expect(run.dryRun).toBe(true);
    expect(run.tasks.every((t) => t.status === "skipped")).toBe(true);
  });

  it("aborts and marks timeout when the turn cap is exceeded", async () => {
    // Two tool-call steps but a maxTurns of 1 → the runner aborts mid-run.
    const provider = new FakeProvider({
      model: "fake-model",
      plan: [
        { tool: { name: "run_bash", args: JSON.stringify({ command: "echo 1" }) } },
        { tool: { name: "run_bash", args: JSON.stringify({ command: "echo 2" }) } },
      ],
    });
    const runner = new EvaluationRunner({
      provider: "fake",
      model: "fake-model",
      tasksDir: FIXTURES,
      resultsDir,
      providerOverride: provider,
      maxTurns: 1,
    });
    const run = await runner.run(["passing"]);
    expect(run.tasks[0]!.status).toBe("timeout");
  });
});
