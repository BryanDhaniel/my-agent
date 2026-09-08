import { newEventId } from "./ids.js";

/**
 * Structured, machine-readable events.
 *
 * This is additive to the existing `src/harness/events.ts` AgentEvent union,
 * which the TUI consumes and which uses hyphenated names (`tool-start`).
 * The observability taxonomy is dotted and carries the execution tree
 * (runId / executionId / parentExecutionId), which the UI-facing events do
 * not need.
 */

export type ExecutionKind = "main-agent" | "sub-agent" | "task" | "tool" | "llm";

export interface ExecutionContext {
  runId: string;
  executionId: string;
  parentExecutionId?: string;
  kind: ExecutionKind;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type ObservabilityEventType =
  // run
  | "run.created"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.timed_out"
  // agent
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "agent.cancelled"
  // llm
  | "llm.request.started"
  | "llm.request.completed"
  | "llm.request.failed"
  | "llm.request.cancelled"
  // tool
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "tool.cancelled"
  // task
  | "task.created"
  | "task.ready"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.retrying"
  | "task.skipped"
  | "task.cancelled"
  // sub-agent
  | "subagent.created"
  | "subagent.started"
  | "subagent.completed"
  | "subagent.failed"
  | "subagent.cancelled"
  // context
  | "context.built"
  | "context.compacted"
  | "context.truncated"
  // permission
  | "permission.requested"
  | "permission.granted"
  | "permission.denied"
  // memory
  | "memory.retrieved"
  | "memory.created"
  | "memory.updated"
  | "memory.rejected"
  // security
  | "security.check"
  | "security.allowed"
  | "security.denied"
  | "security.permission_required"
  | "security.capability_granted"
  | "security.capability_denied"
  | "security.path_blocked"
  | "security.command_blocked"
  | "security.secret_access_blocked"
  | "security.output_truncated"
  | "security.policy_violation"
  // reliability
  | "retry.scheduled"
  | "error.classified";

export interface ObservabilityEvent {
  id: string;
  timestamp: string;
  runId: string;
  executionId: string;
  parentExecutionId?: string;
  type: ObservabilityEventType;
  level: LogLevel;
  /** Small, structured, redacted. Never whole prompts or tool output. */
  metadata?: Record<string, unknown>;
}

export interface EventInput {
  type: ObservabilityEventType;
  context: ExecutionContext;
  level?: LogLevel;
  metadata?: Record<string, unknown>;
}

const LEVEL_BY_TYPE: Partial<Record<ObservabilityEventType, LogLevel>> = {
  "run.failed": "error",
  "agent.failed": "error",
  "llm.request.failed": "error",
  "tool.failed": "error",
  "task.failed": "error",
  "subagent.failed": "error",
  "permission.denied": "warn",
  "memory.rejected": "warn",
  "task.skipped": "warn",
  "retry.scheduled": "warn",
  "error.classified": "debug",
};

export function createEvent(input: EventInput): ObservabilityEvent {
  const { context } = input;
  return {
    id: newEventId(),
    timestamp: new Date().toISOString(),
    runId: context.runId,
    executionId: context.executionId,
    ...(context.parentExecutionId !== undefined
      ? { parentExecutionId: context.parentExecutionId }
      : {}),
    type: input.type,
    level: input.level ?? LEVEL_BY_TYPE[input.type] ?? "info",
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

/** Child context: same run, new execution, parent recorded. */
export function childContext(
  parent: ExecutionContext,
  kind: ExecutionKind,
): ExecutionContext {
  return {
    runId: parent.runId,
    executionId: `${parent.executionId}/${kind}`,
    parentExecutionId: parent.executionId,
    kind,
  };
}
