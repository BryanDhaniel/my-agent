import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import type { ToolSpec } from "../agent/tool.js";
import type { TokenUsage } from "../observability/usage.js";

/**
 * How much reasoning effort to spend, aligned with the providers' own enums
 * (OpenAI's `reasoning_effort` accepts exactly these values). `ultracode`-style
 * levels are deliberately absent: they have no provider equivalent.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StreamOptions {
  signal?: AbortSignal;
  /** Tools the model may call; empty/omitted means none. */
  tools?: ToolSpec[];
  /**
   * Requested reasoning effort. Only meaningful for reasoning models; a
   * provider that does not support it (or whose model does not) ignores it.
   */
  reasoningEffort?: ReasoningEffort;
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
  /**
   * Set the reasoning effort for subsequent streams. Providers whose model
   * does not support it ignore the call (and never send the parameter, which
   * would otherwise be rejected). `StreamOptions.reasoningEffort` overrides
   * this per call.
   */
  setReasoningEffort?(effort: ReasoningEffort): void;
  stream(messages: ChatMessage[], options?: StreamOptions): AsyncIterable<StreamEvent>;
}
