import OpenAI from "openai";
import type {
  AssistantMessage,
  ChatMessage,
  ToolCallRequest,
} from "../agent/types.js";
import type { Provider, StreamEvent, StreamOptions } from "./provider.js";

function toOpenAiMessage(m: ChatMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant": {
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: m.content,
      };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map(
          (tc: ToolCallRequest): OpenAI.Chat.Completions.ChatCompletionMessageToolCall => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          }),
        );
      }
      return msg;
    }
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}

/** Accumulates streamed tool-call deltas keyed by their index. */
class ToolCallAccumulator {
  #partials = new Map<number, { id: string; name: string; args: string }>();

  add(
    deltas: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[] | undefined,
  ): void {
    for (const delta of deltas ?? []) {
      const partial =
        this.#partials.get(delta.index) ?? { id: "", name: "", args: "" };
      if (delta.id) partial.id = delta.id;
      if (delta.function?.name) partial.name += delta.function.name;
      if (delta.function?.arguments) partial.args += delta.function.arguments;
      this.#partials.set(delta.index, partial);
    }
  }

  finish(): ToolCallRequest[] | undefined {
    if (this.#partials.size === 0) return undefined;
    return [...this.#partials.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, p]) => ({ id: p.id, name: p.name, arguments: p.args }));
  }
}

export class OpenAIProvider implements Provider {
  readonly name = "openai";
  readonly model: string;
  #client: OpenAI;

  constructor(apiKey: string, model: string) {
    this.#client = new OpenAI({ apiKey });
    this.model = model;
  }

  async *stream(
    messages: ChatMessage[],
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent> {
    const tools = options?.tools ?? [];
    let completion;
    try {
      completion = await this.#client.chat.completions.create(
        {
          model: this.model,
          messages: messages.map(toOpenAiMessage),
          ...(tools.length > 0
            ? {
                tools: tools.map((t) => ({
                  type: "function" as const,
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  },
                })),
              }
            : {}),
          stream: true,
        },
        { signal: options?.signal },
      );
    } catch (error) {
      yield { type: "error", error };
      return;
    }

    let content = "";
    const toolCalls = new ToolCallAccumulator();
    try {
      for await (const chunk of completion) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        if (delta?.content) {
          content += delta.content;
          yield { type: "text-delta", delta: delta.content };
        }
        if (delta?.tool_calls) {
          toolCalls.add(delta.tool_calls);
        }
      }
    } catch (error) {
      yield { type: "error", error };
      return;
    }

    const message: AssistantMessage = {
      role: "assistant",
      content,
      toolCalls: toolCalls.finish(),
    };
    yield { type: "done", message };
  }
}
