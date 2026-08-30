import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import type { Provider } from "../providers/provider.js";
import { ToolRegistry } from "../agent/registry.js";
import { defaultRegistry } from "../agent/tools/index.js";
import { DenyAllGate, type PermissionGate, type PermissionRequest, type PermissionResponse, type PermissionDecision } from "../permissions/gate.js";
import { ContextManager } from "../context/manager.js";
import { SessionStore, type LoadedSession, type SessionMeta } from "../session/store.js";
import { readdir } from "node:fs/promises";
import {
  type RunState,
  INITIAL_RUN_STATE,
  startRun,
  setAwaitingPermission,
  completeRun,
  failRun,
  cancelRun,
} from "./state.js";
import type { AgentEvent } from "./events.js";
import { AgentRuntime } from "./runtime.js";
import { McpManager, type McpConfig } from "../mcp/index.js";

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

export interface AgentHarnessOptions {
  sessionId?: string;
  continueLast?: boolean;
  cwd?: string;
  gate?: PermissionGate;
  registry?: ToolRegistry;
  context?: ContextManager;
  store?: SessionStore;
  /** MCP server configuration. When set, MCP servers are connected on create(). */
  mcpConfig?: McpConfig;
}

export class AgentHarness {
  #provider: Provider;
  #store: SessionStore;
  #registry: ToolRegistry;
  #gate: PermissionGate;
  #context: ContextManager;
  #history: ChatMessage[];
  #meta: SessionMeta;
  #state: RunState = INITIAL_RUN_STATE;
  #mcpManager?: McpManager;
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
    this.#context = context;
    this.#meta = meta;
    this.cwd = cwd;
    this.#history = [system(buildSystemPrompt(cwd, topLevel)), ...history];

    this.#gate = new StatusTrackingGate(gate, (awaiting) => {
      this.#state = setAwaitingPermission(this.#state, awaiting);
    });
  }

  static async create(
    provider: Provider,
    opts: AgentHarnessOptions = {},
  ): Promise<AgentHarness> {
    const store = opts.store ?? new SessionStore();
    const registry = opts.registry ?? defaultRegistry();
    const gate = opts.gate ?? new DenyAllGate();
    const context = opts.context ?? new ContextManager();
    const cwd = opts.cwd ?? process.cwd();

    // Connect to MCP servers and register their tools.
    let mcpManager: McpManager | undefined;
    if (opts.mcpConfig) {
      mcpManager = await McpManager.connectAll(opts.mcpConfig);
      registry.registerAll([...mcpManager.tools]);
    }

    let loaded: LoadedSession | undefined;
    if (opts.sessionId) {
      loaded = await store.load(opts.sessionId);
      if (!loaded) throw new Error(`Session not found: ${opts.sessionId}`);
    } else if (opts.continueLast) {
      loaded = await store.latest();
    }

    let harness: AgentHarness;
    if (loaded) {
      harness = new AgentHarness(
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
    } else {
      const meta: SessionMeta = {
        id: SessionStore.newId(),
        provider: provider.name,
        model: provider.model,
        createdAt: new Date().toISOString(),
      };
      await store.create(meta);

      harness = new AgentHarness(
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

    harness.#mcpManager = mcpManager;
    return harness;
  }

  get id(): string {
    return this.#meta.id;
  }

  get meta(): SessionMeta {
    return this.#meta;
  }

  get messages(): readonly ChatMessage[] {
    return this.#history;
  }

  get state(): RunState {
    return this.#state;
  }

  get gate(): PermissionGate {
    return this.#gate;
  }

  /** Status of each configured MCP server (empty when MCP is not configured). */
  get mcpStatuses(): readonly import("../mcp/index.js").McpServerStatus[] {
    return this.#mcpManager?.statuses ?? [];
  }

  /** Shut down MCP clients and release resources. */
  async close(): Promise<void> {
    await this.#mcpManager?.close();
  }

  async newSession(): Promise<void> {
    const meta: SessionMeta = {
      id: SessionStore.newId(),
      provider: this.#provider.name,
      model: this.#provider.model,
      createdAt: new Date().toISOString(),
    };
    await this.#store.create(meta);
    this.#resetTo(meta, []);
  }

  async switchTo(id: string): Promise<LoadedSession> {
    const loaded = await this.#store.load(id);
    if (!loaded) throw new Error(`Session not found: ${id}`);
    this.#resetTo(loaded.meta, loaded.messages);
    return loaded;
  }

  #resetTo(meta: SessionMeta, history: ChatMessage[]): void {
    this.#meta = meta;
    const systemPrompt = this.#history.find((m) => m.role === "system");
    this.#history = systemPrompt ? [systemPrompt, ...history] : [...history];
  }

  async *run(text: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    this.#state = startRun(this.#state);
    yield { type: "agent-started", sessionId: this.#meta.id };

    const userMessage: Extract<ChatMessage, { role: "user" }> = {
      role: "user",
      content: text,
    };

    const persistErr = await this.#persistOrError(userMessage);
    if (persistErr) {
      yield { type: "error", error: persistErr };
    }
    yield { type: "user-message", message: userMessage };

    const runtime = new AgentRuntime({
      provider: this.#provider,
      registry: this.#registry,
      gate: this.#gate,
      context: this.#context,
      cwd: this.cwd,
    });

    const iterator = runtime.executeLoop(this.#history, signal);
    let outcome;

    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          outcome = next.value;
          break;
        }

        const event = next.value;
        yield event;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.#state = failRun(this.#state, errorMsg);
      yield { type: "agent-failed", error: errorMsg };
      return;
    }

    if (outcome.additions.length > 0) {
      for (const msg of outcome.additions) {
        const err = await this.#persistOrError(msg);
        if (err) {
          yield { type: "error", error: err };
        }
      }
    }

    if (outcome.status === "cancelled") {
      this.#state = cancelRun(this.#state);
      yield { type: "agent-cancelled" };
    } else if (outcome.status === "failed") {
      const errorMsg = outcome.error?.message ?? "Run failed";
      this.#state = failRun(this.#state, errorMsg);
      yield { type: "agent-failed", error: errorMsg };
    } else {
      this.#state = completeRun(this.#state, outcome.turns);
      yield { type: "agent-completed", status: outcome.status, turns: outcome.turns };
    }
  }

  async #persistOrError(message: ChatMessage): Promise<Error | null> {
    this.#history.push(message);
    try {
      await this.#store.append(this.#meta.id, message);
      return null;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }
}

class StatusTrackingGate implements PermissionGate {
  #inner: PermissionGate;
  #onStatusChange: (awaiting: boolean) => void;

  constructor(inner: PermissionGate, onStatusChange: (awaiting: boolean) => void) {
    this.#inner = inner;
    this.#onStatusChange = onStatusChange;
  }

  async check(request: PermissionRequest): Promise<PermissionDecision> {
    this.#onStatusChange(true);
    try {
      return await this.#inner.check(request);
    } finally {
      this.#onStatusChange(false);
    }
  }

  respond(requestId: string, decision: PermissionResponse): void {
    const inner = this.#inner as { respond?: (id: string, res: PermissionResponse) => void };
    if (typeof inner.respond === "function") {
      inner.respond(requestId, decision);
    }
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
