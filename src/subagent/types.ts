/**
 * Sub-Agent contract.
 *
 * A Sub-Agent is described declaratively: WHAT it should do, never how.
 * The SubAgentManager owns the lifecycle; the parent only ever sees a
 * SubAgentResult, never the child's transcript or runtime.
 */

/** What a delegated Sub-Agent should do. */
export interface SubAgentSpec {
  /** The task, in plain language. Required. */
  task: string;
  /** Role preset name (see roles.ts). Defaults to "general". */
  role?: string;
  /** Provider override; inherits the parent's when omitted. */
  provider?: string;
  /** Model override; inherits the parent's when omitted. */
  model?: string;
  /** Skill names to load into the child's context. */
  skills?: string[];
  /** Tool names the child may use; defaults to the role's allowlist. */
  tools?: string[];
  maxTurns?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Explicit parent -> child handoff. Nothing is copied implicitly: the child
 * only receives what the parent puts here, plus the task itself.
 */
export interface SubAgentContext {
  /** Background the child needs and cannot infer from the task. */
  relevantContext?: string;
  /** Files the child should look at. */
  files?: string[];
  /** Hard rules for this delegation. */
  constraints?: string[];
}

export type SubAgentStatus = "completed" | "failed" | "cancelled";

/** Structured result handed back to the parent. */
export interface SubAgentResult {
  status: SubAgentStatus;
  /** Concise answer — the child's final text, never its transcript. */
  summary: string;
  role?: string;
  provider?: string;
  model?: string;
  turns?: number;
  findings?: string[];
  actionsTaken?: string[];
  filesChanged?: string[];
  errors?: string[];
}

/** Lifecycle events for observability. */
export type SubAgentEvent =
  | { type: "subagent.created"; role: string; provider: string; model: string }
  | { type: "subagent.started"; task: string }
  | { type: "subagent.tool_call"; toolName: string }
  | { type: "subagent.completed"; turns: number }
  | { type: "subagent.failed"; error: string }
  | { type: "subagent.cancelled" };
