import type { AssistantMessage, ChatMessage, ToolCallRequest } from "../../agent/types.js";
import type { Provider, StreamEvent, StreamOptions } from "../../providers/provider.js";
import type { TokenUsage } from "../../observability/usage.js";

/**
 * A deterministic, offline provider for tests. It does NOT call any network and
 * does NOT use a real LLM — instead it follows a scripted plan, invoking a tool
 * when the plan says so and finishing when the plan is exhausted. This lets the
 * EvaluationRunner exercise the real AgentHarness end-to-end without an API key.
 *
 * The plan is a list of steps:
 *  - { tool: { name, args } }  → emit a single assistant message that requests
 *                                that tool call; the harness will execute it and
 *                                feed the result back, then we continue.
 *  - { answer: "..." }         → emit a final assistant message with no tool
 *                                calls; the run terminates.
 *  - { error: "..." }          → emit a stream error (simulates a provider failure).
 */
export type FakeStep =
  | { tool: { name: string; args: string } }
  | { answer: string }
  | { error: string };

export interface FakeProviderOptions {
  plan: FakeStep[];
  /** Token usage attached to the final done event (simulates provider-authoritative counts). */
  usage?: TokenUsage;
  model?: string;
}

export class FakeProvider implements Provider {
  readonly name = "fake";
  readonly model: string;
  #plan: FakeStep[];
  #usage?: TokenUsage;
  #cursor = 0;
  /** Number of times stream() was invoked (one per LLM turn). */
  calls = 0;

  constructor(opts: FakeProviderOptions) {
    this.model = opts.model ?? "fake-model";
    this.#plan = opts.plan;
    this.#usage = opts.usage;
  }

  async *stream(
    _messages: ChatMessage[],
    _options?: StreamOptions,
  ): AsyncGenerator<StreamEvent> {
    this.calls += 1;
    const step = this.#plan[this.#cursor];
    if (step === undefined) {
      // No more scripted steps: end with a neutral answer so the run can finish.
      yield { type: "done", message: { role: "assistant", content: "done" } };
      return;
    }
    this.#cursor += 1;

    if ("error" in step) {
      yield { type: "error", error: new Error(step.error) };
      return;
    }

    if ("tool" in step) {
      const toolCall: ToolCallRequest = {
        id: `call-${this.#cursor}`,
        name: step.tool.name,
        arguments: step.tool.args,
      };
      const message: AssistantMessage = {
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
      };
      yield { type: "done", message };
      return;
    }

    // "answer"
    const message: AssistantMessage = {
      role: "assistant",
      content: step.answer,
      toolCalls: undefined,
    };
    yield { type: "done", message, ...(this.#usage !== undefined ? { usage: this.#usage } : {}) };
  }
}
