import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import type { ToolSpec } from "../agent/tool.js";
import type { TokenUsage } from "../observability/usage.js";

export interface StreamOptions {
  signal?: AbortSignal;
  /** Tools the model may call; empty/omitted means none. */
  tools?: ToolSpec[];
}

/**
 * Events emitted while a single Turn is being generated.
 * The final event is always `done` (with the assembled message) or `error`.
 *
 * `done` may carry authoritative token `usage` when the provider exposes it.
 * Consumers (e.g. evaluation) read this instead of estimating tokens.
 */
export type StreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "done"; message: AssistantMessage; usage?: TokenUsage }
  | { type: "error"; error: unknown };

/** A Provider normalizes one LLM vendor behind a streaming chat interface. */
export interface Provider {
  readonly name: string;
  readonly model: string;
  stream(messages: ChatMessage[], options?: StreamOptions): AsyncIterable<StreamEvent>;
}
