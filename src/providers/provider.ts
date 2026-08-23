import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import type { ToolSpec } from "../agent/tool.js";

export interface StreamOptions {
  signal?: AbortSignal;
  /** Tools the model may call; empty/omitted means none. */
  tools?: ToolSpec[];
}

/**
 * Events emitted while a single Turn is being generated.
 * The final event is always `done` (with the assembled message) or `error`.
 */
export type StreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; error: unknown };

/** A Provider normalizes one LLM vendor behind a streaming chat interface. */
export interface Provider {
  readonly name: string;
  readonly model: string;
  stream(messages: ChatMessage[], options?: StreamOptions): AsyncIterable<StreamEvent>;
}
