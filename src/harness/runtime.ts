import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import type { Provider } from "../providers/provider.js";
import type { ToolRegistry } from "../agent/registry.js";
import type { PermissionGate } from "../permissions/gate.js";
import type { ContextManager } from "../context/manager.js";
import type { AgentEvent } from "./events.js";
import type { SecurityManager } from "../security/manager.js";
import { METRIC, startTimer } from "../observability/index.js";
import type {
  ExecutionContext,
  Observability,
  ObservabilityEventType,
} from "../observability/index.js";

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
  /** When present, every tool call is authorized here before execution. */
  security?: SecurityManager;
  /** Observability sink for LLM and tool spans. Optional by design. */
  observability?: Observability;
  /** Execution context this runtime occupies in the run tree. */
  executionContext?: ExecutionContext;
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

  /** Emit a structured event for this execution when a sink is attached. */
  #trace(type: ObservabilityEventType, metadata?: Record<string, unknown>): void {
    const obs = this.#env.observability;
    const exec = this.#env.executionContext;
    if (obs === undefined || exec === undefined) return;
    obs.emit({ type, context: exec, ...(metadata !== undefined ? { metadata } : {}) });
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

    const obs = this.#env.observability;
    /** Structured trace for this execution; a no-op without a sink. */
    const trace = (type: ObservabilityEventType, metadata?: Record<string, unknown>): void =>
      this.#trace(type, metadata);

    for (; turns < maxTurns; turns++) {
      if (signal?.aborted) {
        return { status: "cancelled", finalText, turns, additions };
      }

      yield { type: "llm-requested", turn: turns };

      let assistantMessage: AssistantMessage | undefined;
      let llmError: Error | undefined;

      const llmMeta = {
        turn: turns,
        provider: this.#env.provider.name,
        model: this.#env.provider.model,
      };
      obs?.metrics.increment(METRIC.llmRequestsTotal);
      trace("llm.request.started", llmMeta);
      const llmContext = this.#env.executionContext;
      const llmSpan =
        obs !== undefined && llmContext !== undefined
          ? obs.span({ context: llmContext, name: "llm.request", metadata: llmMeta })
          : undefined;
      const llmElapsed = startTimer();

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
          llmSpan?.end("cancelled", llmMeta);
          trace("llm.request.cancelled", llmMeta);
          obs?.metrics.increment(METRIC.cancellationsTotal);
          return { status: "cancelled", finalText, turns, additions };
        }
        llmError = err instanceof Error ? err : new Error(String(err));
        yield { type: "error", error: llmError };
      }

      if (llmError) {
        llmSpan?.end("failed", { ...llmMeta, error: llmError.message });
        trace("llm.request.failed", { ...llmMeta, error: llmError.message });
        obs?.metrics.increment(METRIC.llmRequestsFailed);
        return { status: "failed", finalText, turns, additions, error: llmError };
      }

      if (!assistantMessage) {
        const error = new Error("Stream ended without producing an assistant message");
        llmSpan?.end("failed", { ...llmMeta, error: error.message });
        trace("llm.request.failed", { ...llmMeta, error: error.message });
        obs?.metrics.increment(METRIC.llmRequestsFailed);
        yield { type: "error", error };
        return { status: "failed", finalText, turns, additions, error };
      }

      llmSpan?.end("completed", llmMeta);
      trace("llm.request.completed", { ...llmMeta, durationMs: Math.round(llmElapsed()) });
      obs?.metrics.observe(METRIC.llmRequestDurationMs, Math.round(llmElapsed()));

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

    const obs = this.#env.observability;
    const exec = this.#env.executionContext;
    const toolMeta = { toolName: name, callId: id };
    obs?.metrics.increment(METRIC.toolCallsTotal);
    this.#trace("tool.started", toolMeta);
    const toolSpan =
      obs !== undefined && exec !== undefined
        ? obs.span({ context: exec, name: `tool:${name}`, metadata: toolMeta })
        : undefined;
    // Never the arguments themselves: they can contain file contents or
    // commands that must not be copied into the trace.
    const toolElapsed = startTimer();

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
        // Security decides before the permission gate: a policy denial cannot
        // be overridden by user approval or --yolo.
        const security = this.#env.security;
        if (security !== undefined) {
          const decision = await security.checkTool(name, argsJson, this.#env.cwd);
          if (!decision.allowed) {
            const reason = `Blocked by security policy: ${decision.reason}`;
            toolSpan?.end("failed", { ...toolMeta, reason: decision.reason });
            this.#trace("tool.failed", { ...toolMeta, reason: decision.reason });
            obs?.metrics.increment(METRIC.toolCallsFailed);
            yield { type: "tool-denied", callId: id, toolName: name, reason: decision.reason };
            yield { type: "tool-result", callId: id, toolName: name, output: reason };
            return { role: "tool", toolCallId: id, content: reason };
          }
        }

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
              ...(signal !== undefined ? { signal } : {}),
              ...(this.#env.security !== undefined
                ? { security: this.#env.security }
                : {}),
            });
            output =
              result.output.length > MAX_TOOL_RESULT_CHARS
                ? `${result.output.slice(0, MAX_TOOL_RESULT_CHARS)}\n[output truncated at ${MAX_TOOL_RESULT_CHARS} chars]`
                : result.output;

            const durationMs = Math.round(toolElapsed());
            toolSpan?.end("completed", { ...toolMeta, durationMs });
            this.#trace("tool.completed", { ...toolMeta, durationMs });
            obs?.metrics.observe(METRIC.toolCallDurationMs, durationMs);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            toolSpan?.end("failed", { ...toolMeta, error: errMsg });
            this.#trace("tool.failed", { ...toolMeta, error: errMsg });
            obs?.metrics.increment(METRIC.toolCallsFailed);
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
