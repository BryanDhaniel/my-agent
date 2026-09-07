import type { SubAgentResult } from "../subagent/types.js";

/**
 * Orchestration contract.
 *
 * A plan describes a DAG of tasks. Execution is owned by the
 * TaskOrchestrator, which delegates every task to the existing
 * SubAgentManager — it never creates its own agent runtime.
 */

/** One unit of delegated work inside a plan. */
export interface AgentTask {
  /** Unique within the plan. */
  id: string;
  task: string;
  role?: string;
  /** IDs that must complete successfully before this task may start. */
  dependencies?: string[];
  provider?: string;
  model?: string;
  skills?: string[];
  tools?: string[];
  maxTurns?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Extra attempts after the first, for retryable failures only. */
  maxRetries?: number;
}

export type FailureStrategy = "fail-fast" | "continue";

export interface TaskExecutionPlan {
  tasks: AgentTask[];
  /** How many sub-agents may run at once. Clamped, never unbounded. */
  maxConcurrency?: number;
  failureStrategy?: FailureStrategy;
  /** Budget for the whole plan, on top of per-task timeouts. */
  timeoutMs?: number;
}

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  result?: SubAgentResult;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  attempts: number;
}

export type OrchestrationStatus = "completed" | "failed" | "cancelled" | "partial";

export interface OrchestrationResult {
  runId: string;
  status: OrchestrationStatus;
  tasks: TaskResult[];
  /** Concise per-task digest for the parent — never raw transcripts. */
  summary?: string;
}

export type OrchestrationEvent =
  | { type: "orchestration.created"; runId: string; taskCount: number }
  | { type: "orchestration.started"; runId: string }
  | { type: "task.started"; runId: string; taskId: string; role?: string }
  | {
      type: "task.retrying";
      runId: string;
      taskId: string;
      attempt: number;
      reason: string;
    }
  | { type: "task.completed"; runId: string; taskId: string; durationMs: number }
  | { type: "task.failed"; runId: string; taskId: string; error: string }
  | { type: "task.skipped"; runId: string; taskId: string; reason: string }
  | { type: "task.cancelled"; runId: string; taskId: string }
  | {
      type: "orchestration.completed";
      runId: string;
      status: OrchestrationStatus;
      durationMs: number;
    };
