import type { SubAgentManager } from "../subagent/manager.js";
import type { SubAgentContext, SubAgentResult, SubAgentSpec } from "../subagent/types.js";
import { MAX_CONCURRENCY, validatePlan } from "./graph.js";
import { backoffMs, delay, isRetryableError } from "./retry.js";
import type {
  AgentTask,
  FailureStrategy,
  OrchestrationEvent,
  OrchestrationResult,
  OrchestrationStatus,
  TaskExecutionPlan,
  TaskResult,
} from "./types.js";

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_PLAN_TIMEOUT_MS = 300_000;

export interface TaskOrchestratorOptions {
  /** Every task is executed through this; the orchestrator never runs an agent itself. */
  manager: SubAgentManager;
  defaultMaxConcurrency?: number;
  defaultFailureStrategy?: FailureStrategy;
  defaultTimeoutMs?: number;
  onEvent?: (event: OrchestrationEvent) => void;
}

export interface RunPlanOptions {
  signal?: AbortSignal;
}

/**
 * Schedules a DAG of tasks across the existing SubAgentManager.
 *
 * It owns only orchestration concerns — validation, readiness, concurrency,
 * retries, cancellation and aggregation. Provider creation, context building,
 * tool execution, permissions and timeouts all stay inside SubAgentManager,
 * so there is exactly one agent execution path.
 */
export class TaskOrchestrator {
  readonly #manager: SubAgentManager;
  readonly #defaultMaxConcurrency: number;
  readonly #defaultFailureStrategy: FailureStrategy;
  readonly #defaultTimeoutMs: number;
  readonly #onEvent: ((event: OrchestrationEvent) => void) | undefined;
  readonly #active = new Map<string, AbortController>();

  constructor(options: TaskOrchestratorOptions) {
    this.#manager = options.manager;
    this.#defaultMaxConcurrency = options.defaultMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.#defaultFailureStrategy = options.defaultFailureStrategy ?? "continue";
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS;
    this.#onEvent = options.onEvent;
  }

  /** Cancel one run, or every in-flight run when no id is given. */
  cancel(runId?: string): void {
    if (runId === undefined) {
      for (const controller of this.#active.values()) controller.abort();
      return;
    }
    this.#active.get(runId)?.abort();
  }

  async run(
    plan: TaskExecutionPlan,
    options: RunPlanOptions = {},
  ): Promise<OrchestrationResult> {
    const startedAt = Date.now();
    const runId = `orch-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    // Validate before anything runs: a rejected plan starts no sub-agents.
    const validation = validatePlan(plan);
    if (!validation.ok) {
      this.#emit({ type: "orchestration.created", runId, taskCount: plan.tasks?.length ?? 0 });
      this.#emit({ type: "orchestration.completed", runId, status: "failed", durationMs: 0 });
      return {
        runId,
        status: "failed",
        tasks: [],
        summary: `plan rejected: ${validation.errors.join("; ")}`,
      };
    }

    const tasks = plan.tasks;
    const maxConcurrency = Math.min(
      Math.max(1, plan.maxConcurrency ?? this.#defaultMaxConcurrency),
      MAX_CONCURRENCY,
    );
    const strategy = plan.failureStrategy ?? this.#defaultFailureStrategy;

    const results = new Map<string, TaskResult>();
    for (const task of tasks) {
      results.set(task.id, { taskId: task.id, status: "pending", attempts: 0 });
    }

    // One cancellation chain: caller -> orchestrator -> SubAgentManager -> child.
    const controller = new AbortController();
    this.#active.set(runId, controller);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, plan.timeoutMs ?? this.#defaultTimeoutMs);

    const forwardAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", forwardAbort);

    this.#emit({ type: "orchestration.created", runId, taskCount: tasks.length });
    this.#emit({ type: "orchestration.started", runId });

    const running = new Map<string, Promise<void>>();
    let stopping = false;

    const runOne = async (task: AgentTask): Promise<void> => {
      const state = results.get(task.id);
      if (state === undefined) return;

      state.status = "running";
      state.startedAt = new Date();
      this.#emit({
        type: "task.started",
        runId,
        taskId: task.id,
        ...(task.role !== undefined ? { role: task.role } : {}),
      });

      const maxRetries = Math.max(0, task.maxRetries ?? 0);
      const context = dependencyContext(task, results);

      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        state.attempts = attempt;

        let sub: SubAgentResult;
        try {
          sub = await this.#manager.run(toSpec(task), {
            context,
            signal: controller.signal,
            depth: 0,
          });
        } catch (err) {
          state.status = "failed";
          state.error = err instanceof Error ? err.message : String(err);
          state.completedAt = new Date();
          this.#emit({ type: "task.failed", runId, taskId: task.id, error: state.error });
          return;
        }

        if (sub.status === "completed") {
          state.status = "completed";
          state.result = sub;
          state.completedAt = new Date();
          this.#emit({
            type: "task.completed",
            runId,
            taskId: task.id,
            durationMs: state.completedAt.getTime() - (state.startedAt?.getTime() ?? 0),
          });
          return;
        }

        if (sub.status === "cancelled") {
          state.status = "cancelled";
          state.result = sub;
          state.error = timedOut ? "cancelled: orchestration timed out" : "cancelled";
          state.completedAt = new Date();
          this.#emit({ type: "task.cancelled", runId, taskId: task.id });
          return;
        }

        const error = (sub.errors ?? []).join("; ") || "sub-agent failed";
        const canRetry =
          attempt <= maxRetries && isRetryableError(error) && !controller.signal.aborted;

        if (canRetry) {
          this.#emit({
            type: "task.retrying",
            runId,
            taskId: task.id,
            attempt: attempt + 1,
            reason: error,
          });
          await delay(backoffMs(attempt), controller.signal);
          if (controller.signal.aborted) {
            state.status = "cancelled";
            state.error = "cancelled while waiting to retry";
            state.completedAt = new Date();
            this.#emit({ type: "task.cancelled", runId, taskId: task.id });
            return;
          }
          continue;
        }

        state.status = "failed";
        state.result = sub;
        state.error = error;
        state.completedAt = new Date();
        this.#emit({ type: "task.failed", runId, taskId: task.id, error });
        return;
      }
    };

    try {
      while (true) {
        if (controller.signal.aborted) break;

        // fail-fast: any failure stops the plan, not just dependency skips.
        if (strategy === "fail-fast") {
          for (const state of results.values()) {
            if (state.status === "failed") {
              stopping = true;
              break;
            }
          }
        }
        if (stopping) break;

        // A task whose dependency can never succeed is skipped, with a reason.
        for (const task of tasks) {
          const state = results.get(task.id);
          if (state?.status !== "pending") continue;
          if (dependencyBroken(task, results)) {
            state.status = "skipped";
            state.error = "skipped: a dependency did not complete successfully";
            this.#emit({
              type: "task.skipped",
              runId,
              taskId: task.id,
              reason: state.error,
            });
            if (strategy === "fail-fast") stopping = true;
          }
        }
        if (stopping) break;

        for (const task of tasks) {
          if (running.size >= maxConcurrency) break;
          const state = results.get(task.id);
          if (state?.status !== "pending") continue;
          if (!dependenciesSatisfied(task, results)) continue;
          const promise = runOne(task).finally(() => running.delete(task.id));
          running.set(task.id, promise);
        }

        if (running.size === 0) break;
        await Promise.race(running.values());
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", forwardAbort);
      this.#active.delete(runId);
    }

    await Promise.allSettled(running.values());

    // Anything still in flight or unscheduled when we stopped is cancelled.
    for (const task of tasks) {
      const state = results.get(task.id);
      if (state !== undefined && (state.status === "pending" || state.status === "running")) {
        state.status = "cancelled";
        state.error = timedOut
          ? "cancelled: orchestration timed out"
          : "cancelled: execution stopped";
        this.#emit({ type: "task.cancelled", runId, taskId: task.id });
      }
    }

    const taskResults = tasks.map(
      (task) =>
        results.get(task.id) ?? {
          taskId: task.id,
          status: "failed" as const,
          attempts: 0,
          error: "internal: missing task result",
        },
    );
    const status = aggregateStatus(taskResults, timedOut);

    this.#emit({
      type: "orchestration.completed",
      runId,
      status,
      durationMs: Date.now() - startedAt,
    });

    return { runId, status, tasks: taskResults, summary: summarize(taskResults, status) };
  }

  #emit(event: OrchestrationEvent): void {
    this.#onEvent?.(event);
  }
}

function dependenciesSatisfied(task: AgentTask, results: Map<string, TaskResult>): boolean {
  return (task.dependencies ?? []).every(
    (dep) => results.get(dep)?.status === "completed",
  );
}

function dependencyBroken(task: AgentTask, results: Map<string, TaskResult>): boolean {
  return (task.dependencies ?? []).some((dep) => {
    const status = results.get(dep)?.status;
    return status === "failed" || status === "cancelled" || status === "skipped";
  });
}

/**
 * Selected dependency results for a dependent task: summaries, findings and
 * changed files only. Raw child transcripts never cross the boundary.
 */
function dependencyContext(
  task: AgentTask,
  results: Map<string, TaskResult>,
): SubAgentContext | undefined {
  const deps = task.dependencies ?? [];
  if (deps.length === 0) return undefined;

  const lines: string[] = [];
  const files: string[] = [];

  for (const id of deps) {
    const entry = results.get(id);
    const sub = entry?.result;
    if (sub === undefined) continue;

    lines.push(`## ${id} (${entry?.status ?? "unknown"})`);
    if (sub.summary !== "") lines.push(sub.summary);
    for (const finding of sub.findings ?? []) lines.push(`- ${finding}`);
    for (const file of sub.filesChanged ?? []) {
      lines.push(`- changed: ${file}`);
      files.push(file);
    }
    for (const error of sub.errors ?? []) lines.push(`- error: ${error}`);
    lines.push("");
  }

  if (lines.length === 0) return undefined;
  return {
    relevantContext: lines.join("\n").trim(),
    ...(files.length > 0 ? { files } : {}),
  };
}

function toSpec(task: AgentTask): SubAgentSpec {
  return {
    task: task.task,
    ...(task.role !== undefined ? { role: task.role } : {}),
    ...(task.provider !== undefined ? { provider: task.provider } : {}),
    ...(task.model !== undefined ? { model: task.model } : {}),
    ...(task.skills !== undefined ? { skills: task.skills } : {}),
    ...(task.tools !== undefined ? { tools: task.tools } : {}),
    ...(task.capabilities !== undefined ? { capabilities: task.capabilities } : {}),
    ...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
    ...(task.maxTokens !== undefined ? { maxTokens: task.maxTokens } : {}),
    ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
  };
}

function aggregateStatus(tasks: TaskResult[], timedOut: boolean): OrchestrationStatus {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const cancelled = tasks.filter((t) => t.status === "cancelled").length;
  if (completed === tasks.length) return "completed";
  if (completed === 0) return cancelled > 0 || timedOut ? "cancelled" : "failed";
  return "partial";
}

/** Concise digest for the parent — one line per task, no transcripts. */
export function summarize(tasks: TaskResult[], status: OrchestrationStatus): string {
  const count = (wanted: string): number =>
    tasks.filter((t) => t.status === wanted).length;

  const lines: string[] = [
    `orchestration ${status} — ${count("completed")} completed, ${count("failed")} failed, ` +
      `${count("skipped")} skipped, ${count("cancelled")} cancelled (of ${tasks.length})`,
  ];

  for (const task of tasks) {
    lines.push("");
    lines.push(`${task.taskId}: ${task.status}`);
    if (task.result?.summary !== undefined && task.result.summary !== "") {
      lines.push(`  ${firstLine(task.result.summary)}`);
    }
    if (task.error !== undefined) lines.push(`  ${firstLine(task.error)}`);
  }

  return lines.join("\n");
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > 300 ? `${line.slice(0, 297)}...` : line.trim();
}
