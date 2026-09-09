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
import { SkillRegistry, SkillResolver, SkillResolverError } from "../skills/index.js";
import type { Observability } from "../observability/index.js";
import { METRIC, startTimer } from "../observability/index.js";
import type { SecurityManager } from "../security/manager.js";
import {
  LocalMemoryStore,
  MemoryManager,
  extractMemoryCandidates,
  type MemoryStore,
} from "../memory/index.js";
import type { ContextSummary } from "../context/summary.js";
import type { SlashCommand } from "../ui/commands.js";

/** Constraints that must survive every trim, so they live in the context, not the prompt. */
export const PERMISSION_CONSTRAINTS = [
  "## Permissions",
  "- Mutating Tool Calls (writes, edits, shell commands) require approval before they run.",
  "- A denied Tool Call comes back to you as an error. Do not retry it unchanged — propose an alternative.",
  "- Never ask for secrets, API keys or tokens, and never write them to files or memory.",
].join("\n");

/** How many memories a single run may bring into context. */
const MEMORY_TOP_K = 8;

export function buildSystemPrompt(
  cwd: string,
  topLevel: string,
  skillCatalog?: string,
): string {
  const parts = [
    "You are my-agent, a terminal coding agent working in the user's project directory.",
    "You can read, create, edit, search files and run shell commands via your tools.",
    "Use tools whenever they help; prefer relative paths; be concise and direct.",
    "",
    `Project root: ${cwd}`,
    `Top-level entries:\n${topLevel}`,
  ];

  if (skillCatalog) {
    parts.push("", skillCatalog);
  }

  return parts.join("\n");
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
  /** Pre-built SkillRegistry. When set, skills are available for invocation. */
  skills?: SkillRegistry;
  /** Pre-built MemoryManager. When omitted, a LocalMemoryStore under the cwd is used. */
  memory?: MemoryManager;
  /** Backing store for the default MemoryManager. Ignored when `memory` is set. */
  memoryStore?: MemoryStore;
  /** Security boundary every tool call is authorized against. */
  security?: SecurityManager;
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
  #skills: SkillRegistry;
  #skillResolver: SkillResolver;
  #memory?: MemoryManager;
  #observability?: Observability;
  #security?: SecurityManager;
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
    skills: SkillRegistry,
    summary?: ContextSummary,
  ) {
    this.#provider = provider;
    this.#store = store;
    this.#registry = registry;
    this.#context = context;
    this.#meta = meta;
    this.#skills = skills;
    this.#skillResolver = new SkillResolver(skills);
    this.cwd = cwd;

    // Context is rebuilt, not persisted: the summary comes from the session
    // log, the permission constraints are a property of the harness.
    this.#context.restoreSummary(summary);
    this.#context.setPermissionContext(PERMISSION_CONSTRAINTS);

    // Build skill catalog for model-invoked skills.
    const modelSkills = skills.listModelInvoked();
    const skillCatalog = modelSkills.length > 0
      ? buildSkillCatalog(modelSkills)
      : undefined;

    this.#history = [system(buildSystemPrompt(cwd, topLevel, skillCatalog)), ...history];

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
    const skills = opts.skills ?? new SkillRegistry();

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

    // Memory is loaded once per harness and outlives individual Sessions.
    const memory =
      opts.memory ??
      (await MemoryManager.create({
        store: opts.memoryStore ?? new LocalMemoryStore(LocalMemoryStore.defaultPath(cwd)),
      }));

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
        skills,
        loaded.summary,
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
        skills,
      );
    }

    harness.#mcpManager = mcpManager;
    harness.#memory = memory;
    if (opts.security) harness.setSecurity(opts.security);
    return harness;
  }

  /**
   * Attach an observability sink. Optional — the harness runs identically
   * without one, so observability is never a hard dependency of execution.
   */
  setObservability(observability: Observability): void {
    this.#observability = observability;
  }

  /**
   * Attach the security boundary. When set, every tool call is authorized
   * here before the permission gate, so a policy denial cannot be approved
   * away by the user or by --yolo.
   */
  setSecurity(security: SecurityManager): void {
    this.#security = security;
  }

  /**
   * Swap the provider for FUTURE runs only.
   *
   * An in-flight run captured its own snapshot when it started, so switching
   * provider or model mid-run cannot rewrite the provider underneath a
   * request, a sub-agent, a parallel task or a retry.
   */
  setProvider(provider: Provider): void {
    this.#provider = provider;
    this.#meta = {
      ...this.#meta,
      provider: provider.name,
      model: provider.model,
    };
  }

  /** Which provider and model the next run will use. */
  get activeModel(): { provider: string; model: string } {
    return { provider: this.#provider.name, model: this.#provider.model };
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

  /** Skill registry (for TUI listing). */
  get skills(): SkillRegistry {
    return this.#skills;
  }

  /** Skill names formatted as SlashCommands for TUI autocomplete. */
  get skillCommands(): SlashCommand[] {
    return this.#skills.listUserInvoked().map((s) => ({
      name: s.name,
      description: s.description,
    }));
  }

  /** The MemoryManager for this harness — durable knowledge, not conversation. */
  get memory(): MemoryManager | undefined {
    return this.#memory;
  }

  /** The ContextManager — read-only access for inspection and diagnostics. */
  get context(): ContextManager {
    return this.#context;
  }

  async newSession(): Promise<void> {
    const meta: SessionMeta = {
      id: SessionStore.newId(),
      provider: this.#provider.name,
      model: this.#provider.model,
      createdAt: new Date().toISOString(),
    };
    await this.#store.create(meta);
    // A new Session starts with a clean context: no summary, no active skills.
    this.#resetTo(meta, [], undefined);
  }

  async switchTo(id: string): Promise<LoadedSession> {
    const loaded = await this.#store.load(id);
    if (!loaded) throw new Error(`Session not found: ${id}`);
    this.#resetTo(loaded.meta, loaded.messages, loaded.summary);
    return loaded;
  }

  #resetTo(meta: SessionMeta, history: ChatMessage[], summary?: ContextSummary): void {
    this.#meta = meta;
    const systemPrompt = this.#history.find((m) => m.role === "system");
    this.#history = systemPrompt ? [systemPrompt, ...history] : [...history];
    // Memory is untouched: it belongs to the project, not to the Session.
    this.#context.restoreSummary(summary);
    this.#context.clearSkills();
    this.#context.clearRunContext();
  }

  async *run(text: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    // Snapshot: everything below uses `provider`, never `this.#provider`, so a
    // /provider or /model switch during this run cannot retarget it.
    const provider = this.#provider;
    const obs = this.#observability;
    const runContext = obs?.newRun();
    const runSpan =
      runContext !== undefined ? obs?.span({ context: runContext, name: "run" }) : undefined;
    const runElapsed = runContext !== undefined ? startTimer() : undefined;
    if (obs !== undefined && runContext !== undefined) {
      obs.metrics.increment(METRIC.agentRunsTotal);
      obs.emit({
        type: "run.started",
        context: runContext,
        metadata: {
          sessionId: this.#meta.id,
          provider: this.#meta.provider,
          model: this.#meta.model,
        },
      });
    }

    this.#state = startRun(this.#state);
    yield { type: "agent-started", sessionId: this.#meta.id };

    // Per-run context is rebuilt from scratch; retrieved memories from the
    // previous run must not leak into this one.
    this.#context.clearRunContext();

    // Skill interception: if the text starts with /skillname, resolve the
    // skill and offer its instructions to the ContextManager. They are
    // context, not history — so they are budgeted and prioritizable instead
    // of accumulating in the persisted transcript.
    let effectiveText = text;
    const skillMatch = /^\/([a-zA-Z][a-zA-Z0-9-]*)(?:\s|$)/.exec(text);
    if (skillMatch) {
      const skillName = skillMatch[1]!;
      try {
        const skill = this.#skillResolver.resolve(skillName);
        this.#context.addSkillContext({ name: skill.name, instructions: skill.instructions });
        yield { type: "skill-activated", name: skill.name } as AgentEvent;

        // Strip the /skillname prefix — pass remaining text (or skill description) to the model.
        const remainder = text.slice(skillMatch[0].length).trim();
        effectiveText = remainder || `Use the ${skill.name} skill: ${skill.description}`;
      } catch (err) {
        if (!(err instanceof SkillResolverError)) throw err;
        // Not a skill — fall through to normal processing.
      }
    }

    // The request itself is the active task — second only to the system
    // prompt in priority, so it survives even aggressive trimming.
    this.#context.setTaskContext(effectiveText);

    // Memory retrieval feeds the ContextManager, never the prompt: the agent
    // never assembles a memory block by hand. This has to happen before the
    // loop starts, but the event is announced after the user message so the
    // notice stays grouped with the turn it belongs to.
    let recalledCount = 0;
    if (this.#memory !== undefined) {
      const recalled = await this.#memory.retrieve({ text: effectiveText, topK: MEMORY_TOP_K });
      this.#context.setMemoryContext(
        recalled.map((r) => ({
          id: r.memory.id,
          content: r.memory.content,
          category: r.memory.category,
          importance: r.memory.importance,
        })),
      );
      recalledCount = recalled.length;
    }

    const userMessage: Extract<ChatMessage, { role: "user" }> = {
      role: "user",
      content: effectiveText,
    };

    const persistErr = await this.#persistOrError(userMessage);
    if (persistErr) {
      yield { type: "error", error: persistErr };
    }
    yield { type: "user-message", message: userMessage };

    if (recalledCount > 0) {
      yield { type: "memory-recalled", count: recalledCount };
    }

    const runtime = new AgentRuntime({
      provider,
      registry: this.#registry,
      gate: this.#gate,
      context: this.#context,
      cwd: this.cwd,
      ...(this.#security !== undefined ? { security: this.#security } : {}),
      ...(this.#observability !== undefined ? { observability: this.#observability } : {}),
      ...(runContext !== undefined ? { executionContext: runContext } : {}),
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
      if (obs !== undefined && runContext !== undefined) {
        obs.metrics.increment(METRIC.agentRunsFailed);
        runSpan?.end("failed", { error: errorMsg });
        obs.emit({
          type: "run.failed",
          context: runContext,
          metadata: { error: errorMsg, durationMs: Math.round(runElapsed?.() ?? 0) },
        });
      }
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

    // Compaction before memory extraction, so extraction sees the whole run.
    yield* this.#compactContext();

    if (outcome.status === "completed") {
      yield* this.#extractMemories([userMessage, ...outcome.additions]);
    }

    if (outcome.status === "cancelled") {
      this.#state = cancelRun(this.#state);
      if (obs !== undefined && runContext !== undefined) {
        obs.metrics.increment(METRIC.agentRunsCancelled);
        obs.metrics.increment(METRIC.cancellationsTotal);
        runSpan?.end("cancelled");
        obs.emit({
          type: "run.cancelled",
          context: runContext,
          metadata: { durationMs: Math.round(runElapsed?.() ?? 0) },
        });
      }
      yield { type: "agent-cancelled" };
    } else if (outcome.status === "failed") {
      const errorMsg = outcome.error?.message ?? "Run failed";
      this.#state = failRun(this.#state, errorMsg);
      if (obs !== undefined && runContext !== undefined) {
        obs.metrics.increment(METRIC.agentRunsFailed);
        runSpan?.end("failed", { error: errorMsg });
        obs.emit({
          type: "run.failed",
          context: runContext,
          metadata: { error: errorMsg, durationMs: Math.round(runElapsed?.() ?? 0) },
        });
      }
      yield { type: "agent-failed", error: errorMsg };
    } else {
      this.#state = completeRun(this.#state, outcome.turns);
      if (obs !== undefined && runContext !== undefined) {
        const durationMs = Math.round(runElapsed?.() ?? 0);
        obs.metrics.increment(METRIC.agentRunsSuccess);
        obs.metrics.observe(METRIC.agentRunDurationMs, durationMs);
        runSpan?.end("completed", { turns: outcome.turns });
        obs.emit({
          type: "run.completed",
          context: runContext,
          metadata: { turns: outcome.turns, durationMs },
        });
      }
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

  /**
   * Fold the conversation into a summary when it outgrows its budget.
   *
   * The transcript on disk stays complete — only the window the
   * ContextManager reads from moves. Persistence failures degrade to an
   * error event, exactly like message persistence.
   */
  async *#compactContext(): AsyncGenerator<AgentEvent> {
    const result = await this.#context.compact(this.#history);
    if (result === undefined) return;

    try {
      await this.#store.appendSummary(this.#meta.id, result.summary);
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
    }
    yield { type: "context-compacted", coveredMessages: result.coveredMessages };
  }

  /**
   * Decide whether this run produced anything worth remembering.
   *
   * Extraction is conservative by design; the MemoryManager does the final
   * safety gate, so a rejected candidate simply is not stored.
   */
  async *#extractMemories(messages: readonly ChatMessage[]): AsyncGenerator<AgentEvent> {
    if (this.#memory === undefined) return;

    const candidates = extractMemoryCandidates({ messages, sessionId: this.#meta.id });
    let stored = 0;

    for (const candidate of candidates) {
      const result = await this.#memory.store({
        ...candidate,
        source: `session:${this.#meta.id}`,
      });
      if (result.status !== "rejected") stored++;
    }

    yield { type: "memory-stored", count: stored };
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

function buildSkillCatalog(skills: import("../skills/index.js").SkillMetadata[]): string {
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    "Available skills (behavioral guides you can reference when relevant):",
    ...lines,
  ].join("\n");
}
