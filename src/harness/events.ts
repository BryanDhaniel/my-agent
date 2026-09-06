import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import type { ContextSummary } from "../context/summary.js";

export type AgentEvent =
  | { type: "user-message"; message: Extract<ChatMessage, { role: "user" }> }
  | { type: "text-delta"; delta: string }
  | { type: "assistant-message"; message: AssistantMessage }
  | { type: "tool-start"; callId: string; toolName: string; argsJson: string }
  | { type: "tool-denied"; callId: string; toolName: string; reason: string }
  | { type: "tool-result"; callId: string; toolName: string; output: string }
  | { type: "error"; error: unknown }
  | { type: "agent-started"; sessionId: string }
  | { type: "agent-completed"; status: string; turns: number }
  | { type: "agent-failed"; error: string }
  | { type: "agent-cancelled" }
  | { type: "llm-requested"; turn: number }
  | { type: "llm-completed"; turn: number }
  | { type: "tool-requested"; callId: string; toolName: string }
  | { type: "tool-failed"; callId: string; toolName: string; error: string }
  | { type: "skill-activated"; name: string }
  /** Memories retrieved for this run and handed to the ContextManager. */
  | { type: "memory-recalled"; count: number }
  /** Candidate memories extracted from this run and persisted. */
  | { type: "memory-stored"; count: number }
  /** The conversation outgrew its budget and was folded into a summary. */
  | { type: "context-compacted"; coveredMessages: number };
