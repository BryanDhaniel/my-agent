import { ToolRegistry } from "../agent/registry.js";
import type { ChatMessage } from "../agent/types.js";
import { ContextManager } from "../context/manager.js";
import { AgentRuntime, type RuntimeOutcome } from "../harness/runtime.js";
import type { AgentEvent } from "../harness/events.js";
import { createProvider } from "../providers/create-provider.js";
import { apiKeyEnvVar, isProviderName, resolveApiKey, type ProviderName } from "../config.js";
import type { PermissionGate } from "../permissions/gate.js";
import type { Provider } from "../providers/provider.js";
import type { SkillRegistry } from "../skills/index.js";
import { DEFAULT_ROLE, resolveRole, roleNames } from "./roles.js";
import type { SubAgentContext, SubAgentEvent, SubAgentResult, SubAgentSpec } from "./types.js";

/** The delegation tool is never handed to a Sub-Agent (recursion guard). */
export const DELEGATE_TOOL_NAME = "delegate_to_agent";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TURNS = 10;

export interface SubAgentParent {
  provider: ProviderName;
  model: string;
}

export interface SubAgentManagerOptions {
  /** Parent provider/model, inherited when a spec omits them. */
  parent: SubAgentParent;
  /** Source of tool implementations; children get a filtered view of it. */
  registry: ToolRegistry;
  /** The same gate as the parent, so permissions are never bypassed. */
  gate: PermissionGate;
  cwd: string;
  skills?: SkillRegistry;
  /** Main agent is depth 0; a sub-agent at depth >= this is refused. */
  maxSubAgentDepth?: number;
  defaultTimeoutMs?: number;
  defaultMaxTurns?: number;
  onEvent?: (event: SubAgentEvent) => void;
  /**
   * Seam for tests: builds the child's Provider. Defaults to the normal
   * factory, so production always goes through `createProvider`.
   */
  providerFactory?: (args: {
    provider: ProviderName;
    model: string;
    apiKey: string;
  }) => Provider;
}

export interface RunSubAgentOptions {
  context?: SubAgentContext;
  /** Parent cancellation, propagated into the child. */
  signal?: AbortSignal;
  depth?: number;
}

/**
 * Owns the Sub-Agent lifecycle: create, run, limit, cancel, collect.
 *
 * It deliberately contains no provider-specific logic — provider choice goes
 * through the normal factory — and it reuses the existing Agent loop,
 * ToolRegistry, PermissionGate, ContextManager and Skills rather than
 * reimplementing any of them.
 */
export class SubAgentManager {
  readonly #parent: SubAgentParent;
  readonly #registry: ToolRegistry;
  readonly #gate: PermissionGate;
  readonly #cwd: string;
  readonly #skills: SkillRegistry | undefined;
  readonly #maxDepth: number;
  readonly #defaultTimeoutMs: number;
  readonly #defaultMaxTurns: number;
  readonly #onEvent: ((event: SubAgentEvent) => void) | undefined;
  readonly #providerFactory: NonNullable<SubAgentManagerOptions["providerFactory"]>;

  constructor(options: SubAgentManagerOptions) {
    this.#parent = options.parent;
    this.#registry = options.registry;
    this.#gate = options.gate;
    this.#cwd = options.cwd;
    this.#skills = options.skills;
    this.#maxDepth = options.maxSubAgentDepth ?? 1;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#defaultMaxTurns = options.defaultMaxTurns ?? DEFAULT_MAX_TURNS;
    this.#onEvent = options.onEvent;
    this.#providerFactory =
      options.providerFactory ?? ((args) => createProvider(args));
  }

  get maxDepth(): number {
    return this.#maxDepth;
  }

  async run(
    spec: SubAgentSpec,
    options: RunSubAgentOptions = {},
  ): Promise<SubAgentResult> {
    const { context, signal, depth = 0 } = options;
    const roleName = spec.role ?? DEFAULT_ROLE;
    const errors: string[] = [];

    const refuse = (error: string): SubAgentResult => {
      this.#emit({ type: "subagent.failed", error });
      return { status: "failed", summary: "", role: roleName, errors: [error] };
    };

    if (depth >= this.#maxDepth) {
      return refuse(
        `sub-agent depth limit reached (${this.#maxDepth}) — nested delegation is disabled`,
      );
    }
    if (spec.task === undefined || spec.task.trim() === "") {
      return refuse("sub-agent spec is missing a task");
    }

    const role = resolveRole(spec.role);
    if (role === undefined) {
      return refuse(`unknown role "${spec.role}" — expected one of ${roleNames().join(", ")}`);
    }

    // Provider/model: explicit override, otherwise inherit from the parent.
    const providerName = spec.provider ?? this.#parent.provider;
    if (!isProviderName(providerName)) {
      return refuse(`unknown provider "${spec.provider}" — expected openai, anthropic, gemini or glm`);
    }
    const model = spec.model ?? this.#parent.model;
    const apiKey = resolveApiKey(providerName);
    if (apiKey === undefined || apiKey === "") {
      return refuse(
        `missing API key for ${providerName} — set ${apiKeyEnvVar(providerName)}`,
      );
    }

    // Tools: a filtered view of the parent registry. Never the delegate tool.
    const childRegistry = new ToolRegistry();
    for (const name of spec.tools ?? role.tools) {
      if (name === DELEGATE_TOOL_NAME) {
        errors.push(`${DELEGATE_TOOL_NAME} is not available to sub-agents`);
        continue;
      }
      const tool = this.#registry.get(name);
      if (tool === undefined) {
        errors.push(`unknown tool "${name}"`);
        continue;
      }
      childRegistry.register(tool);
    }
    if (childRegistry.list().length === 0) {
      return refuse(
        `no usable tools for role "${roleName}"${errors.length > 0 ? ` — ${errors.join("; ")}` : ""}`,
      );
    }

    // Skills come from the existing registry; unknown ones are reported.
    const skillContexts: Array<{ name: string; instructions: string }> = [];
    for (const name of spec.skills ?? role.skills) {
      const skill = this.#skills?.get(name);
      if (skill === undefined) {
        errors.push(`unknown skill "${name}"`);
        continue;
      }
      skillContexts.push({ name: skill.name, instructions: skill.instructions });
    }

    const taskText = buildTask(spec.task, context);

    // Child context: only the task and what the parent explicitly handed over.
    // The parent conversation is never copied in.
    const contextManager = new ContextManager(
      spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {},
    );
    contextManager.setSystemContext(role.system);
    contextManager.setSkillContext(skillContexts);
    contextManager.setTaskContext(taskText);

    const provider = this.#providerFactory({ provider: providerName, model, apiKey });
    const runtime = new AgentRuntime({
      provider,
      registry: childRegistry,
      gate: this.#gate,
      context: contextManager,
      cwd: this.#cwd,
      maxTurns: spec.maxTurns ?? this.#defaultMaxTurns,
    });

    this.#emit({ type: "subagent.created", role: roleName, provider: providerName, model });
    this.#emit({ type: "subagent.started", task: spec.task });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, spec.timeoutMs ?? this.#defaultTimeoutMs);

    const forwardAbort = (): void => controller.abort();
    signal?.addEventListener("abort", forwardAbort);

    const actionsTaken: string[] = [];
    const filesChanged: string[] = [];

    const history: ChatMessage[] = [{ role: "user", content: taskText }];
    const iterator = runtime.executeLoop(history, controller.signal);

    try {
      /**
       * A child that ignores its AbortSignal would otherwise leave us waiting
       * forever, so every step races the signal. We stop waiting and report a
       * structured result rather than hanging the parent.
       */
      const ABORTED = Symbol("aborted");
      const aborted = new Promise<typeof ABORTED>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(ABORTED));
      });
      const next = (): Promise<IteratorResult<AgentEvent, RuntimeOutcome> | typeof ABORTED> =>
        Promise.race([iterator.next(), aborted]);

      let step = await next();
      while (step !== ABORTED && step.done !== true) {
        const event = step.value;
        if (event.type === "tool-start") {
          actionsTaken.push(event.toolName);
          this.#emit({ type: "subagent.tool_call", toolName: event.toolName });
          const file = changedFile(event.toolName, event.argsJson);
          if (file !== undefined) filesChanged.push(file);
        } else if (event.type === "tool-denied") {
          errors.push(`permission denied for ${event.toolName}: ${event.reason}`);
        } else if (event.type === "tool-failed") {
          errors.push(`${event.toolName} failed: ${event.error}`);
        }
        step = await next();
      }

      if (step === ABORTED) {
        if (timedOut) {
          const error = `sub-agent execution timed out after ${spec.timeoutMs ?? this.#defaultTimeoutMs}ms`;
          this.#emit({ type: "subagent.failed", error });
          return this.#finish({
            status: "failed",
            summary: "",
            roleName,
            providerName,
            model,
            actionsTaken,
            filesChanged,
            errors: [...errors, error],
          });
        }
        this.#emit({ type: "subagent.cancelled" });
        return this.#finish({
          status: "cancelled",
          summary: "",
          roleName,
          providerName,
          model,
          actionsTaken,
          filesChanged,
          errors,
        });
      }

      const outcome = step.value;

      if (timedOut) {
        const error = `sub-agent execution timed out after ${spec.timeoutMs ?? this.#defaultTimeoutMs}ms`;
        this.#emit({ type: "subagent.failed", error });
        return this.#finish({
          status: "failed",
          summary: "",
          roleName,
          providerName,
          model,
          turns: outcome.turns,
          actionsTaken,
          filesChanged,
          errors: [...errors, error],
        });
      }

      if (outcome.status === "cancelled" || controller.signal.aborted) {
        this.#emit({ type: "subagent.cancelled" });
        return this.#finish({
          status: "cancelled",
          summary: outcome.finalText,
          roleName,
          providerName,
          model,
          turns: outcome.turns,
          actionsTaken,
          filesChanged,
          errors,
        });
      }

      if (outcome.status === "failed") {
        const error = outcome.error?.message ?? "sub-agent failed";
        this.#emit({ type: "subagent.failed", error });
        return this.#finish({
          status: "failed",
          summary: outcome.finalText,
          roleName,
          providerName,
          model,
          turns: outcome.turns,
          actionsTaken,
          filesChanged,
          errors: [...errors, error],
        });
      }

      this.#emit({ type: "subagent.completed", turns: outcome.turns });
      return this.#finish({
        status: "completed",
        summary: outcome.finalText.trim() === "" ? "(no output)" : outcome.finalText,
        roleName,
        providerName,
        model,
        turns: outcome.turns,
        actionsTaken,
        filesChanged,
        errors,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.#emit({ type: "subagent.failed", error });
      return this.#finish({
        // A failed child must never take the parent down with it.
        status: "failed",
        summary: "",
        roleName,
        providerName,
        model,
        actionsTaken,
        filesChanged,
        errors: [...errors, error],
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
      // Best-effort teardown of the child loop; not awaited, because a child
      // stuck on an un-cancellable call must not block the parent's result.
      // The cast is unavoidable: AsyncGenerator.return demands a TReturn we
      // do not have here, and the call is only a teardown signal.
      void iterator.return(undefined as unknown as RuntimeOutcome);
    }
  }

  #emit(event: SubAgentEvent): void {
    this.#onEvent?.(event);
  }

  #finish(args: {
    status: SubAgentResult["status"];
    summary: string;
    roleName: string;
    providerName: ProviderName;
    model: string;
    turns?: number;
    actionsTaken: string[];
    filesChanged: string[];
    errors: string[];
  }): SubAgentResult {
    return {
      status: args.status,
      summary: args.summary,
      role: args.roleName,
      provider: args.providerName,
      model: args.model,
      ...(args.turns !== undefined ? { turns: args.turns } : {}),
      ...(args.actionsTaken.length > 0 ? { actionsTaken: args.actionsTaken } : {}),
      ...(args.filesChanged.length > 0 ? { filesChanged: args.filesChanged } : {}),
      ...(args.errors.length > 0 ? { errors: args.errors } : {}),
    };
  }
}

/**
 * The task plus only what the parent explicitly handed over. Nothing else
 * from the parent conversation crosses the boundary.
 */
function buildTask(task: string, context: SubAgentContext | undefined): string {
  const parts: string[] = [task.trim()];
  if (context?.relevantContext !== undefined && context.relevantContext !== "") {
    parts.push(`\nContext:\n${context.relevantContext}`);
  }
  if (context?.files !== undefined && context.files.length > 0) {
    parts.push(`\nRelevant files:\n${context.files.map((f) => `- ${f}`).join("\n")}`);
  }
  if (context?.constraints !== undefined && context.constraints.length > 0) {
    parts.push(
      `\nConstraints:\n${context.constraints.map((c) => `- ${c}`).join("\n")}`,
    );
  }
  return parts.join("\n");
}

/** Best-effort file attribution for write/edit calls, for the result summary. */
function changedFile(toolName: string, argsJson: string): string | undefined {
  if (toolName !== "write_file" && toolName !== "edit_file") return undefined;
  try {
    const parsed: unknown = JSON.parse(argsJson || "{}");
    if (typeof parsed === "object" && parsed !== null) {
      const path = (parsed as Record<string, unknown>)["path"];
      if (typeof path === "string") return path;
    }
  } catch {
    // Unparseable args: simply don't attribute a file.
  }
  return undefined;
}
