import Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import type { Provider, StreamEvent, StreamOptions } from "./provider.js";
import {
  ContentBlockTracker,
  toAnthropicParams,
  toAnthropicTools,
} from "./anthropic-mapping.js";

const MAX_TOKENS = 8192;

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly model: string;
  #client: Anthropic;

  constructor(apiKey: string, model: string) {
    this.#client = new Anthropic({ apiKey });
    this.model = model;
  }

  async *stream(
    messages: ChatMessage[],
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent> {
    const { system, messages: anthropicMessages } = toAnthropicParams(messages);
    const tools = options?.tools ?? [];

    let eventStream;
    try {
      eventStream = await this.#client.messages.create(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          ...(system !== undefined ? { system } : {}),
          messages: anthropicMessages,
          ...(tools.length > 0 ? { tools: toAnthropicTools(tools) } : {}),
          stream: true,
        },
        { signal: options?.signal },
      );
    } catch (error) {
      yield { type: "error", error };
      return;
    }

    let content = "";
    const blocks = new ContentBlockTracker();

    try {
      for await (const event of eventStream) {
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            content += event.delta.text;
            yield { type: "text-delta", delta: event.delta.text };
            continue;
          }
          if (event.delta.type === "input_json_delta") {
            blocks.appendJson(event.index, event.delta.partial_json);
          }
          continue;
        }
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          blocks.start(event.index, event.content_block.id, event.content_block.name);
        }
      }
    } catch (error) {
      yield { type: "error", error };
      return;
    }

    const message: AssistantMessage = {
      role: "assistant",
      content,
      toolCalls: blocks.finish(),
    };
    yield { type: "done", message };
  }
}
