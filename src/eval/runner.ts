import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Memory, MemoryStore } from "../memory/index.js";
import { MemoryManager } from "../memory/index.js";
import { AgentHarness } from "../harness/harness.js";
import { defaultRegistry } from "../agent/tools/index.js";
import { AutoApproveGate } from "../permissions/gate.js";
import { SecurityManager, defaultSecurityPolicy } from "../security/index.js";
import { SessionStore } from "../session/store.js";
import { SkillRegistry } from "../skills/index.js";
import { Observability, newRunId, startTimer } from "../observability/index.js";
import { PricingRegistry } from "../observability/usage.js";
import { createProvider } from "../providers/create-provider.js";
import type { ProviderName } from "../config.js";
import { prepareFixture } from "./fixture-manager.js";
import { loadTask, resolveFixturePath } from "./task-loader.js";
import { runValidation } from "./validator.js";
import { categoryBreakdown, summarize } from "./metrics.js";
import type { EvaluationRun, RunnerOptions, TaskResult, TaskStatus } from "./types.js";

/**
 * Runs curated tasks through the REAL AgentHarness (headless).
 *
 * Responsibilities, per the spec:
 *  - sequential execution, isolated fixtures, conservative defaults
 *  - no real API calls in dry-run
 *  - provider-agnostic: token usage comes from the harness observability sink,
 *    cost from a configurable (possibly empty) pricing registry
 *  - security boundary scoped to the fixture dir (mode "workspace")
 *  - turn cap via AbortController so a stuck task cannot run forever / rack cost
 */
export class EvaluationRunner {
  readonly #opts: RunnerOptions;
  readonly #pricing: PricingRegistry;

  constructor(opts: RunnerOptions) {
    this.#opts = opts;
    this.#pricing = opts.pricing ?? new PricingRegistry();
  }

  /**
   * Execute the given task ids (or all tasks when `ids` is empty) and return a
   * single aggregated run. Each task is run sequentially in its own isolated
   * fixture; the harness is rebuilt per task so runs never share state.
   */
  async run(ids: string[]): Promise<EvaluationRun> {
    const taskIds = ids.length > 0 ? ids : await this.#allTaskIds();
    const observability = this.#opts.observability ?? new Observability({ pricing: this.#pricing });

    const results: TaskResult[] = [];
    for (const id of taskIds) {
      results.push(await this.#runTask(observability, id));
    }

    const run: EvaluationRun = {
      id: newRunId(),
      createdAt: new Date().toISOString(),
      provider: this.#opts.provider,
      model: this.#opts.model,
      ...(this.#opts.commitSha !== undefined ? { commitSha: this.#opts.commitSha } : {}),
      ...(this.#opts.commitSha === undefined
        ? { commitSha: this.#captureCommitSha() ?? undefined }
        : {}),
      dryRun: this.#opts.dryRun ?? false,
      tasksDir: this.#opts.tasksDir,
      pricingSource: this.#pricing.size > 0 ? "configured" : "unknown",
      summary: summarize(results),
      categoryBreakdown: categoryBreakdown(results),
      tasks: results,
    };
    return run;
  }

  async #allTaskIds(): Promise<string[]> {
    const { listTasks } = await import("./task-loader.js");
    return listTasks(this.#opts.tasksDir);
  }

  async #runTask(obs: Observability, id: string): Promise<TaskResult> {
    const now = new Date().toISOString();
    const base: Omit<TaskResult, "status" | "success" | "durationMs" | "llmTurns" | "toolCalls" | "tokens" | "cost" | "validationExitCode" | "error"> = {
      id,
      category: "bug-fix",
      prompt: "",
      provider: this.#opts.provider,
      model: this.#opts.model,
      createdAt: now,
    };

    let task;
    try {
      task = await loadTask(id, this.#opts.tasksDir);
    } catch (err) {
      return {
        ...base,
        category: "bug-fix",
        prompt: "",
        status: "error",
        success: false,
        durationMs: 0,
        llmTurns: 0,
        toolCalls: 0,
        tokens: {},
        cost: { currency: "unknown" },
        error: (err as Error).message,
      };
    }

    base.category = task.category;
    base.prompt = task.prompt;

    // Dry-run: no provider, no execution, no API calls. Report what would run.
    if (this.#opts.dryRun) {
      return {
        ...base,
        status: "skipped",
        success: false,
        durationMs: 0,
        llmTurns: 0,
        toolCalls: 0,
        tokens: {},
        cost: { currency: "unknown" },
      };
    }

    const fixtureSrc = resolveFixturePath(task, this.#opts.tasksDir);
    const fixture = await prepareFixture(fixtureSrc);

    const runIdHolder: { runId?: string } = {};
    const unsubscribe = obs.bus.subscribe((event) => {
      if (event.type === "run.started") runIdHolder.runId = event.runId;
    });

    const memoryStore = new InMemoryMemoryStore();
    const security = new SecurityManager({
      policy: defaultSecurityPolicy(fixture.dir, "workspace"),
      observability: obs,
      label: `eval:${id}`,
    });
    const store = new SessionStore(join(fixture.dir, ".sessions"));
    const gate = new AutoApproveGate();

    let status: TaskStatus = "passed";
    let errorMsg: string | undefined;
    let llmTurns = 0;
    let toolCalls = 0;
    let aborted = false;
    let validationExitCode: number | undefined;
    const timer = startTimer();

    // The runner's safety cap is authoritative: an explicit `--max-turns` (or the
    // runner default) must not be widened by a per-task override, otherwise a
    // stuck task could run far longer than the operator intended. The task's own
    // `maxTurns` applies only when the runner does not specify one.
    const maxTurns = this.#opts.maxTurns ?? task.maxTurns;
    const controller = new AbortController();

    try {
      const harness = await AgentHarness.create(this.#provider(), {
        cwd: fixture.dir,
        gate,
        store,
        security,
        skills: new SkillRegistry(),
        memory: new MemoryManager({ store: memoryStore }),
      });
      harness.setObservability(obs);

      for await (const event of harness.run(task.prompt, controller.signal)) {
        if (event.type === "llm-requested") {
          llmTurns += 1;
          if (maxTurns !== undefined && llmTurns > maxTurns) {
            aborted = true;
            controller.abort();
          }
        } else if (event.type === "tool-start") {
          toolCalls += 1;
        } else if (event.type === "agent-failed") {
          status = "failed";
          errorMsg = event.error;
        } else if (event.type === "agent-cancelled") {
          status = "timeout";
        }
      }

      if (aborted && status === "passed") status = "timeout";
    } catch (err) {
      status = "error";
      errorMsg = (err as Error).message;
    } finally {
      unsubscribe();
    }

    // Validate only on a clean completion; otherwise the failure is the signal.
    if (status === "passed") {
      const outcome = await runValidation(
        task.validation.command,
        task.validation.cwd !== undefined ? join(fixture.dir, task.validation.cwd) : fixture.dir,
        task.validation.timeoutMs ?? this.#opts.validationTimeoutMs ?? 60_000,
      );
      validationExitCode = outcome.exitCode;
      if (!outcome.ok) {
        status = "failed";
        errorMsg = outcome.error ?? `validation exited with code ${outcome.exitCode}`;
      }
    }

    const tokens = runIdHolder.runId !== undefined ? obs.usageFor(runIdHolder.runId) : {};
    const cost =
      runIdHolder.runId !== undefined
        ? obs.costFor(runIdHolder.runId, this.#opts.model)
        : { currency: "unknown" };

    await fixture.cleanup();

    return {
      ...base,
      status,
      success: status === "passed",
      durationMs: Math.round(timer()),
      llmTurns,
      toolCalls,
      tokens,
      cost,
      ...(validationExitCode !== undefined ? { validationExitCode } : {}),
      ...(errorMsg !== undefined ? { error: errorMsg } : {}),
    };
  }

  #provider() {
    if (this.#opts.providerOverride !== undefined) return this.#opts.providerOverride;
    return createProvider({
      provider: this.#opts.provider as ProviderName,
      model: this.#opts.model,
      apiKey: this.#opts.apiKey ?? "",
    });
  }

  #captureCommitSha(): string | undefined {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  }
}

/** Memory store that keeps nothing on disk — eval tasks are isolated. */
class InMemoryMemoryStore implements MemoryStore {
  #items = new Map<string, Memory>();

  async load(): Promise<Memory[]> {
    return [...this.#items.values()];
  }
  async save(memory: Memory): Promise<void> {
    this.#items.set(memory.id, memory);
  }
  async remove(id: string): Promise<void> {
    this.#items.delete(id);
  }
}
