import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import type { Provider } from "../providers/provider.js";
import type { ToolRegistry } from "../agent/registry.js";
import type { PermissionGate } from "../permissions/gate.js";
import type { ContextManager } from "../context/manager.js";
import type { AgentEvent } from "./events.js";

const MAX_TURNS = 25;
const MAX_TOOL_RESULT_CHARS = 8_000;

export interface RuntimeEnvironment {
  provider: Provider;
  registry: ToolRegistry;
  gate: PermissionGate;
  context: ContextManager;
  cwd: string;
  /** Per-run Turn cap. Defaults to MAX_TURNS when omitted. */
  maxTurns?: number;
}

export interface RuntimeOutcome {
  status: "completed" | "failed" | "cancelled";
  finalText: string;
  turns: number;
  additions: ChatMessage[];
  error?: Error;
}

export class AgentRuntime {
  #env: RuntimeEnvironment;

  constructor(env: RuntimeEnvironment) {
    this.#env = env;
  }

  async *executeLoop(
    history: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, RuntimeOutcome> {
    const additions: ChatMessage[] = [];
    const fullHistory = [...history];
    const maxTurns = this.#env.maxTurns ?? MAX_TURNS;
    let turns = 0;
    let finalText = "";

    for (; turns < maxTurns; turns++) {
      if (signal?.aborted) {
        return { status: "cancelled", finalText, turns, additions };
      }

      yield { type: "llm-requested", turn: turns };

      let assistantMessage: AssistantMessage | undefined;
      let llmError: Error | undefined;

      try {
        // The ContextManager decides what the model sees — the runtime never
        // assembles context itself.
        for await (const event of this.#env.provider.stream(
          this.#env.context.buildContext(fullHistory),
          { signal, tools: this.#env.registry.specs() },
        )) {
          if (event.type === "text-delta") {
            finalText += event.delta;
            yield event;
          } else if (event.type === "done") {
            assistantMessage = event.message;
          } else if (event.type === "error") {
            llmError = event.error instanceof Error ? event.error : new Error(String(event.error));
            yield { type: "error", error: llmError };
            break;
          }
        }
      } catch (err) {
        if (signal?.aborted) {
          return { status: "cancelled", finalText, turns, additions };
        }
        llmError = err instanceof Error ? err : new Error(String(err));
        yield { type: "error", error: llmError };
      }

      if (llmError) {
        return { status: "failed", finalText, turns, additions, error: llmError };
      }

      if (!assistantMessage) {
        const error = new Error("Stream ended without producing an assistant message");
        yield { type: "error", error };
        return { status: "failed", finalText, turns, additions, error };
      }

      yield { type: "llm-completed", turn: turns };
      yield { type: "assistant-message", message: assistantMessage };
      additions.push(assistantMessage);
      fullHistory.push(assistantMessage);

      const calls = assistantMessage.toolCalls ?? [];
      if (calls.length === 0) {
        turns++;
        return { status: "completed", finalText, turns, additions };
      }

      for (const call of calls) {
        if (signal?.aborted) {
          return { status: "cancelled", finalText, turns, additions };
        }
        const toolResult = yield* this.#executeCall(call, signal);
        additions.push(toolResult);
        fullHistory.push(toolResult);
      }
    }

    const turnLimitError = new Error(`Agent Loop hit the ${maxTurns}-Turn limit`);
    yield { type: "error", error: turnLimitError };
    return { status: "failed", finalText, turns: maxTurns, additions, error: turnLimitError };
  }

  async *#executeCall(
    call: NonNullable<AssistantMessage["toolCalls"]>[number],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, Extract<ChatMessage, { role: "tool" }>> {
    const { id, name, arguments: argsJson } = call;
    yield { type: "tool-requested", callId: id, toolName: name };
    yield { type: "tool-start", callId: id, toolName: name, argsJson };

    const tool = this.#env.registry.get(name);
    let output: string;

    if (!tool) {
      output = `Error: unknown tool "${name}"`;
      yield { type: "tool-failed", callId: id, toolName: name, error: output };
    } else {
      const parsed = this.#env.registry.parse(name, argsJson);
      if (!parsed.ok) {
        output = `Error: ${parsed.error}`;
        yield { type: "tool-failed", callId: id, toolName: name, error: output };
      } else {
        const ruleKey = tool.ruleKey !== undefined ? tool.ruleKey(parsed.data) : undefined;
        let decision: Awaited<ReturnType<PermissionGate["check"]>> = { allowed: true };

        if (tool.mutating) {
          decision = await this.#env.gate.check({
            id,
            toolName: name,
            summary: describeCall(tool.name, parsed.data),
            ruleKey,
          });
        }

        if (!decision.allowed) {
          yield { type: "tool-denied", callId: id, toolName: name, reason: decision.reason };
          output = `Error: permission denied — ${decision.reason}`;
        } else {
          try {
            const result = await this.#env.registry.invoke(name, argsJson, {
              cwd: this.#env.cwd,
              signal,
            });
            output =
              result.output.length > MAX_TOOL_RESULT_CHARS
                ? `${result.output.slice(0, MAX_TOOL_RESULT_CHARS)}\n[output truncated at ${MAX_TOOL_RESULT_CHARS} chars]`
                : result.output;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            output = `Error executing tool "${name}": ${errMsg}`;
            yield { type: "tool-failed", callId: id, toolName: name, error: errMsg };
          }
        }
      }
    }

    const resultMessage: Extract<ChatMessage, { role: "tool" }> = {
      role: "tool",
      toolCallId: id,
      content: output,
    };
    yield { type: "tool-result", callId: id, toolName: name, output };
    return resultMessage;
  }
}

function describeCall(toolName: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return `${toolName} ${String(input)}`;
  const parsed = input as Record<string, unknown>;
  if (toolName === "write_file" && typeof parsed["path"] === "string") {
    const bytes = typeof parsed["content"] === "string" ? parsed["content"].length : 0;
    return `write_file ${parsed["path"]} (${bytes} bytes)`;
  }
  if (toolName === "edit_file" && typeof parsed["path"] === "string") {
    return `edit ${parsed["path"]}`;
  }
  if (toolName === "run_bash" && typeof parsed["command"] === "string") {
    return `run \`${parsed["command"]}\``;
  }
  return `${toolName} ${JSON.stringify(parsed)}`;
}
