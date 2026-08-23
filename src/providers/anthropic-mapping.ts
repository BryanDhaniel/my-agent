import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantMessage,
  ChatMessage,
  ToolCallRequest,
} from "../agent/types.js";
import type { ToolSpec } from "../agent/tool.js";

/**
 * Pure translation of our normalized history into Anthropic's shape:
 * system text moves to a top-level param, Tool Results become tool_result
 * blocks grouped into the user message that must follow their Tool Calls.
 */
export function toAnthropicParams(
  messages: ChatMessage[],
): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  let system: string | undefined;
  const out: Anthropic.MessageParam[] = [];

  const flushToolResults = (blocks: Anthropic.ToolResultBlockParam[]): void => {
    if (blocks.length === 0) return;
    out.push({ role: "user", content: blocks });
  };

  let pendingResults: Anthropic.ToolResultBlockParam[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "system":
        system = system ? `${system}\n${m.content}` : m.content;
        break;

      case "user":
        flushToolResults(pendingResults);
        pendingResults = [];
        out.push({ role: "user", content: m.content });
        break;

      case "assistant": {
        flushToolResults(pendingResults);
        pendingResults = [];
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content !== "") {
          content.push({ type: "text", text: m.content });
        }
        for (const tc of m.toolCalls ?? []) {
          content.push(toolUseBlock(tc));
        }
        out.push({ role: "assistant", content });
        break;
      }

      case "tool":
        pendingResults.push({
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content,
        });
        break;
    }
  }
  flushToolResults(pendingResults);

  return { system, messages: out };
}

function toolUseBlock(tc: ToolCallRequest): Anthropic.ToolUseBlockParam {
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(tc.arguments || "{}");
    input = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    input = {};
  }
  return { type: "tool_use", id: tc.id, name: tc.name, input };
}

export function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Tracks streamed content blocks so scattered input_json_delta chunks can be
 * assembled into complete Tool Calls once each block stops.
 */
export class ContentBlockTracker {
  #tools = new Map<number, { id: string; name: string; json: string }>();

  start(index: number, id: string, name: string): void {
    this.#tools.set(index, { id, name, json: "" });
  }

  appendJson(index: number, partialJson: string | undefined): void {
    const block = this.#tools.get(index);
    if (block !== undefined && partialJson !== undefined) {
      block.json += partialJson;
    }
  }

  /** Assemble finished Tool Calls in block order; undefined when there were none. */
  finish(): ToolCallRequest[] | undefined {
    if (this.#tools.size === 0) return undefined;
    return [...this.#tools.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, b]) => ({ id: b.id, name: b.name, arguments: b.json }));
  }
}
