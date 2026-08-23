import type { AssistantMessage, ChatMessage } from "./types.js";
import type { Provider } from "../providers/provider.js";
import { ToolRegistry } from "./registry.js";
import type { PermissionGate } from "../permissions/gate.js";
import { ContextManager } from "../context/manager.js";
import {
  SessionStore,
  type LoadedSession,
  type SessionMeta,
} from "../session/store.js";
import { readdir } from "node:fs/promises";

/** Hard ceiling on Turns per user message — stops runaway tool loops. */
const MAX_TURNS = 25;

/** Central cap on any single Tool Result, so one tool can't flood context. */
const MAX_TOOL_RESULT_CHARS = 8_000;

export function buildSystemPrompt(cwd: string, topLevel: string): string {
  return [
    "You are my-agent, a terminal coding agent working in the user's project directory.",
    "You can read, create, edit, search files and run shell commands via your tools.",
    "Use tools whenever they help; prefer relative paths; be concise and direct.",
    "",
    `Project root: ${cwd}`,
    `Top-level entries:\n${topLevel}`,
  ].join("\n");
}

export type ChatEvent =
  | { type: "user-message"; message: Extract<ChatMessage, { role: "user" }> }
  | { type: "text-delta"; delta: string }
  | { type: "assistant-message"; message: AssistantMessage }
  | { type: "tool-start"; callId: string; toolName: string; argsJson: string }
  | { type: "tool-denied"; callId: string; toolName: string; reason: string }
  | { type: "tool-result"; callId: string; toolName: string; output: string }
  | { type: "error"; error: unknown };

export interface ChatServiceOptions {
  sessionId?: string;
  continueLast?: boolean;
  cwd?: string;
}

/**
 * Owns the conversation history for one Session and runs the Agent Loop:
 * stream a response, execute requested Tool Calls, feed results back,
 * repeat until the model answers without tools.
 */
export class ChatService {
  #provider: Provider;
  #store: SessionStore;
  #registry: ToolRegistry;
  #gate: PermissionGate;
  #context: ContextManager;
  #history: ChatMessage[];
  readonly meta: SessionMeta;
  readonly cwd: string;

  private constructor(
    provider: Provider,
    store: SessionStore,
    registry: ToolRegistry,
    gate: PermissionGate,
    meta: SessionMeta,
    history: ChatMessage[],
    cwd: string,
    context: ContextManager,
    topLevel: string,
  ) {
    this.#provider = provider;
    this.#store = store;
    this.#registry = registry;
    this.#gate = gate;
    this.#context = context;
    this.meta = meta;
    this.#history = [system(buildSystemPrompt(cwd, topLevel)), ...history];
    this.cwd = cwd;
  }

  /** Resume an existing session by id/last, or start a fresh one. */
  static async start(
    provider: Provider,
    store: SessionStore,
    registry: ToolRegistry,
    gate: PermissionGate,
    opts: ChatServiceOptions = {},
    context: ContextManager = new ContextManager(),
  ): Promise<ChatService> {
    const cwd = opts.cwd ?? process.cwd();
    let loaded: LoadedSession | undefined;
    if (opts.sessionId) {
      loaded = await store.load(opts.sessionId);
      if (!loaded) throw new Error(`Session not found: ${opts.sessionId}`);
    } else if (opts.continueLast) {
      loaded = await store.latest();
    }

    if (loaded) {
      return new ChatService(
        provider,
        store,
        registry,
        gate,
        loaded.meta,
        loaded.messages,
        cwd,
        context,
        await topLevelListing(cwd),
      );
    }

    const meta: SessionMeta = {
      id: SessionStore.newId(),
      provider: provider.name,
      model: provider.model,
      createdAt: new Date().toISOString(),
    };
    await store.create(meta);
    return new ChatService(
      provider,
      store,
      registry,
      gate,
      meta,
      [],
      cwd,
      context,
      await topLevelListing(cwd),
    );
  }

  get id(): string {
    return this.meta.id;
  }

  get messages(): readonly ChatMessage[] {
    return this.#history;
  }

  /**
   * Run one full Agent Loop triggered by the given user text.
   * Yields events as they happen; ends after the model's final text answer
   * or an error.
   */
  async *send(text: string, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    const userMessage: Extract<ChatMessage, { role: "user" }> = {
      role: "user",
      content: text,
    };
    await this.#persist(userMessage);
    yield { type: "user-message", message: userMessage };

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const assistant = yield* this.#turn(signal);
      if (!assistant) return;

      const calls = assistant.toolCalls ?? [];
      if (calls.length === 0) return; // final answer — loop done

      for (const call of calls) {
        yield* this.#executeCall(call, signal);
      }
    }

    yield {
      type: "error",
      error: new Error(`Agent Loop hit the ${MAX_TURNS}-Turn limit`),
    };
  }

  /** One streaming Turn; returns the assembled assistant message or undefined on error. */
  async *#turn(signal?: AbortSignal): AsyncGenerator<ChatEvent, AssistantMessage | undefined> {
    let assistant: AssistantMessage | undefined;
    for await (const event of this.#provider.stream(
      this.#context.trimForRequest(this.#history),
      { signal, tools: this.#registry.specs() },
    )) {
      if (event.type === "text-delta") {
        yield event;
        continue;
      }
      if (event.type === "done") {
        assistant = event.message;
        break;
      }
      // error
      yield { type: "error", error: event.error };
      return undefined;
    }

    if (!assistant) {
      yield { type: "error", error: new Error("Stream ended without a final message") };
      return undefined;
    }

    await this.#persist(assistant);
    yield { type: "assistant-message", message: assistant };
    return assistant;
  }

  async *#executeCall(
    call: NonNullable<AssistantMessage["toolCalls"]>[number],
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const { id, name, arguments: argsJson } = call;
    yield { type: "tool-start", callId: id, toolName: name, argsJson };

    const tool = this.#registry.get(name);
    let output: string;
    if (!tool) {
      output = `Error: unknown tool "${name}"`;
    } else {
      // Validate before gating so the allowlist key comes from good args;
      // invoke() re-validates, failures become error outputs either way.
      const parsed = this.#registry.parse(name, argsJson);
      if (!parsed.ok) {
        output = `Error: ${parsed.error}`;
      } else {
        const ruleKey =
          tool.ruleKey !== undefined ? tool.ruleKey(parsed.data) : undefined;

        let decision: Awaited<ReturnType<PermissionGate["check"]>> = { allowed: true };
        if (tool.mutating) {
          decision = await this.#gate.check({
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
          const result = await this.#registry.invoke(name, argsJson, {
            cwd: this.cwd,
            signal,
          });
          output =
            result.output.length > MAX_TOOL_RESULT_CHARS
              ? `${result.output.slice(0, MAX_TOOL_RESULT_CHARS)}\n[output truncated at ${MAX_TOOL_RESULT_CHARS} chars]`
              : result.output;
        }
      }
    }

    await this.#persist({ role: "tool", toolCallId: id, content: output });
    yield { type: "tool-result", callId: id, toolName: name, output };
  }

  async #persist(message: ChatMessage): Promise<void> {
    this.#history.push(message);
    await this.#store.append(this.meta.id, message);
  }
}

function system(content: string): ChatMessage {
  return { role: "system", content };
}

async function topLevelListing(cwd: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch {
    return "(unavailable)";
  }
  const names = entries
    .filter((e) => !e.name.startsWith("."))
    .slice(0, 40)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  return names.length > 0 ? names.join("\n") : "(empty directory)";
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
