import { CapabilitySet, capabilitiesForMode, defaultChildCapabilities } from "./capabilities.js";
import { checkCommandAccess, type CommandDecision } from "./commands.js";
import { checkEnvironmentAccess, safeEnvironment } from "./environment.js";
import { checkPathAccess, type PathDecision, type PathOperation } from "./paths.js";
import { METRIC, type Observability } from "../observability/index.js";
import type {
  Capability,
  ResourceLimits,
  RiskLevel,
  SecurityContext,
  SecurityDecision,
  SecurityPolicy,
} from "./types.js";

/**
 * The single security authority.
 *
 * Tools ask; they do not decide. Nothing here can be switched off by the
 * model, and there is deliberately no `disable()` / `allowAll()` API.
 */

export type SecurityAuditType =
  | "security.check"
  | "security.allowed"
  | "security.denied"
  | "security.permission_required"
  | "security.capability_denied"
  | "security.path_blocked"
  | "security.command_blocked"
  | "security.secret_access_blocked"
  | "security.output_truncated"
  | "security.policy_violation";

export type ResourceLimitKind =
  | "outputBytes"
  | "fileReadBytes"
  | "fileWriteBytes"
  | "commandDurationMs";

export interface SecurityManagerOptions {
  policy: SecurityPolicy;
  capabilities?: CapabilitySet;
  observability?: Observability;
  executionId?: string;
  parentExecutionId?: string;
  runId?: string;
  label?: string;
}

export class SecurityManager {
  readonly context: SecurityContext;
  readonly #observability: Observability | undefined;
  #checks = 0;
  #denials = 0;

  constructor(options: SecurityManagerOptions) {
    const capabilities =
      options.capabilities ?? new CapabilitySet(capabilitiesForMode(options.policy.mode));

    this.context = {
      executionId: options.executionId ?? "exec_security",
      ...(options.parentExecutionId !== undefined
        ? { parentExecutionId: options.parentExecutionId }
        : {}),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      mode: options.policy.mode,
      workspaceRoot: options.policy.workspaceRoot,
      capabilities,
      policy: options.policy,
      ...(options.label !== undefined ? { label: options.label } : {}),
    };
    this.#observability = options.observability;
  }

  get workspaceRoot(): string {
    return this.context.workspaceRoot;
  }

  get capabilities(): CapabilitySet {
    return this.context.capabilities;
  }

  // ── Checks ────────────────────────────────────────────────────────

  async checkFileAccess(
    requestedPath: string,
    operation: PathOperation,
    cwd: string = this.workspaceRoot,
  ): Promise<PathDecision> {
    const decision = await checkPathAccess({
      workspaceRoot: this.workspaceRoot,
      requested: requestedPath,
      cwd,
      operation,
      policy: this.context.policy.filesystem,
      capabilities: this.capabilities,
      mode: this.context.mode,
    });
    this.#audit(decision, "file", operation, { path: requestedPath });
    return decision;
  }

  checkCommand(command: string, cwd: string = this.workspaceRoot): CommandDecision {
    const decision = checkCommandAccess({
      command,
      cwd,
      workspaceRoot: this.workspaceRoot,
      policy: this.context.policy.commands,
      capabilities: this.capabilities,
      mode: this.context.mode,
    });
    this.#audit(decision, "command", decision.analysis.classification, {
      executables: decision.analysis.executables,
    });
    return decision;
  }

  checkEnvironmentAccess(name: string): SecurityDecision {
    const decision = checkEnvironmentAccess({
      name,
      policy: this.context.policy.environment,
      capabilities: this.capabilities,
    });
    if (!decision.allowed) {
      this.#emit("security.secret_access_blocked", decision, { variable: name });
    }
    return decision;
  }

  checkCapability(capability: Capability): SecurityDecision {
    const allowed = this.capabilities.has(capability);
    const decision: SecurityDecision = allowed
      ? {
          allowed: true,
          requiresConfirmation: false,
          reason: `capability "${capability}" granted`,
          riskLevel: "low",
          capability,
        }
      : {
          allowed: false,
          requiresConfirmation: false,
          reason: `blocked: missing capability "${capability}"`,
          riskLevel: "high",
          capability,
        };
    this.#audit(decision, "capability", capability, {});
    return decision;
  }

  /** Native + MCP tools funnel through here by name and arguments. */
  async checkTool(
    toolName: string,
    argsJson: string,
    cwd: string = this.workspaceRoot,
  ): Promise<SecurityDecision> {
    const args = parseArgs(argsJson);

    switch (toolName) {
      case "read_file":
        return this.checkFileAccess(pathArg(args), "read", cwd);
      case "write_file":
      case "edit_file":
        return this.checkFileAccess(pathArg(args), "write", cwd);
      case "glob":
      case "grep":
        return this.checkFileAccess(pathArg(args, "."), "read", cwd);
      case "run_bash":
        return this.checkCommand(commandArg(args), cwd);
      default:
        return this.checkMCPTool(undefined, toolName);
    }
  }

  /** MCP tools are untrusted by default: allowed only when explicitly listed. */
  checkMCPTool(server: string | undefined, tool: string): SecurityDecision {
    const { mcp } = this.context.policy;

    if (!this.capabilities.has("mcp.use")) {
      const decision: SecurityDecision = {
        allowed: false,
        requiresConfirmation: false,
        reason: 'blocked: missing capability "mcp.use"',
        riskLevel: "high",
        capability: "mcp.use",
      };
      this.#audit(decision, "mcp", tool, { server });
      return decision;
    }

    if (mcp.deniedTools.includes(tool)) {
      const decision: SecurityDecision = {
        allowed: false,
        requiresConfirmation: false,
        reason: `MCP tool "${tool}" is denied by policy`,
        riskLevel: "critical",
        capability: "mcp.use",
      };
      this.#audit(decision, "mcp", tool, { server });
      return decision;
    }

    if (
      server !== undefined &&
      mcp.allowedServers.length > 0 &&
      !mcp.allowedServers.includes(server)
    ) {
      const decision: SecurityDecision = {
        allowed: false,
        requiresConfirmation: false,
        reason: `MCP server "${server}" is not on the allowlist`,
        riskLevel: "critical",
        capability: "mcp.use",
      };
      this.#audit(decision, "mcp", tool, { server });
      return decision;
    }

    const known = mcp.allowedTools.includes(tool);
    const decision: SecurityDecision = {
      // Fail closed: an unknown MCP tool is never silently allowed.
      allowed: known,
      requiresConfirmation: known,
      reason: known
        ? "MCP tool is allowlisted and requires confirmation"
        : `unknown MCP tool "${tool}" — denied until it is allowlisted`,
      riskLevel: known ? "medium" : "high",
      capability: "mcp.use",
    };
    this.#emit(decision.allowed ? "security.permission_required" : "security.denied", decision, {
      tool,
      server,
    });
    return decision;
  }

  /** Configured limit for a resource, or undefined when unlimited. */
  resourceLimit(kind: ResourceLimitKind): number | undefined {
    return limitFor(this.context.policy.limits, kind);
  }

  /**
   * Filtered view of the environment for child processes. Tools get this
   * instead of `process.env`.
   */
  safeEnv(source?: NodeJS.ProcessEnv): Record<string, string> {
    return safeEnvironment({
      policy: this.context.policy.environment,
      capabilities: this.capabilities,
      ...(source !== undefined ? { source } : {}),
    });
  }

  checkResourceLimit(kind: ResourceLimitKind, value: number): SecurityDecision {
    const limit = limitFor(this.context.policy.limits, kind);
    if (limit === undefined || value <= limit) {
      return {
        allowed: true,
        requiresConfirmation: false,
        reason: "within resource limits",
        riskLevel: "low",
      };
    }
    const decision: SecurityDecision = {
      allowed: true,
      requiresConfirmation: false,
      reason: `${kind} exceeded the ${limit} limit — output will be truncated`,
      riskLevel: "low",
    };
    this.#emit("security.output_truncated", decision, { kind, value, limit });
    return decision;
  }

  // ── Child contexts ────────────────────────────────────────────────

  /**
   * Narrow this context for a child. Requested capabilities the parent lacks
   * are dropped and reported — a child cannot widen its own authority.
   */
  childContext(input: {
    executionId: string;
    capabilities?: Capability[];
    label?: string;
  }): SecurityContext {
    const requested =
      input.capabilities ?? defaultChildCapabilities(this.capabilities).list();

    const escalation = this.capabilities.escalationAttempts(requested);
    if (escalation.length > 0) {
      const decision: SecurityDecision = {
        allowed: false,
        requiresConfirmation: false,
        reason: `refused privilege escalation: ${escalation.join(", ")}`,
        riskLevel: "critical",
      };
      this.#emit("security.policy_violation", decision, {
        requested: escalation,
        child: input.executionId,
      });
    }

    return {
      executionId: input.executionId,
      parentExecutionId: this.context.executionId,
      ...(this.context.runId !== undefined ? { runId: this.context.runId } : {}),
      mode: this.context.mode,
      workspaceRoot: this.workspaceRoot,
      capabilities: this.capabilities.intersect(requested),
      policy: this.context.policy,
      ...(input.label !== undefined ? { label: input.label } : {}),
    };
  }

  /** Convenience: a manager bound to a narrowed child context. */
  child(input: {
    executionId: string;
    capabilities?: Capability[];
    label?: string;
  }): SecurityManager {
    return new SecurityManager({
      policy: this.context.policy,
      capabilities: this.childContext(input).capabilities,
      ...(this.#observability !== undefined ? { observability: this.#observability } : {}),
      executionId: input.executionId,
      parentExecutionId: this.context.executionId,
      ...(this.context.runId !== undefined ? { runId: this.context.runId } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
    });
  }

  // ── Audit ─────────────────────────────────────────────────────────

  #audit(
    decision: SecurityDecision,
    surface: string,
    operation: string,
    metadata: Record<string, unknown>,
  ): void {
    this.#checks++;
    if (!decision.allowed) this.#denials++;

    const type: SecurityAuditType = !decision.allowed
      ? surface === "command"
        ? "security.command_blocked"
        : surface === "file"
          ? "security.path_blocked"
          : "security.denied"
      : decision.requiresConfirmation
        ? "security.permission_required"
        : "security.allowed";

    this.#emit(type, decision, { surface, operation, ...metadata });
  }

  #emit(
    type: SecurityAuditType,
    decision: SecurityDecision,
    metadata: Record<string, unknown>,
  ): void {
    const obs = this.#observability;
    if (obs === undefined) return;

    // Counters, in the existing in-process collector — no external backend.
    obs.metrics.increment(METRIC.securityChecksTotal);
    if (!decision.allowed) obs.metrics.increment(METRIC.securityDenialsTotal);
    if (decision.requiresConfirmation) obs.metrics.increment(METRIC.permissionRequestsTotal);
    if (type === "security.command_blocked" || type === "security.denied") {
      if (metadata["surface"] === "command") {
        obs.metrics.increment(METRIC.dangerousCommandsBlockedTotal);
      }
    }
    if (type === "security.path_blocked") {
      obs.metrics.increment(METRIC.pathTraversalsBlockedTotal);
    }
    if (type === "security.secret_access_blocked") {
      obs.metrics.increment(METRIC.secretAccessBlockedTotal);
    }

    const context = {
      runId: this.context.runId ?? "run_unknown",
      executionId: this.context.executionId,
      ...(this.context.parentExecutionId !== undefined
        ? { parentExecutionId: this.context.parentExecutionId }
        : {}),
      kind: "tool" as const,
    };

    // No raw values: paths and commands are recorded for audit, never secrets,
    // and the logger redacts strings on the way out.
    obs.emit({
      type: type as never,
      context,
      metadata: {
        ...(this.context.label !== undefined ? { agent: this.context.label } : {}),
        decision: decision.allowed ? "allowed" : "denied",
        requiresConfirmation: decision.requiresConfirmation,
        risk: decision.riskLevel,
        reason: decision.reason,
        ...(decision.capability !== undefined ? { capability: decision.capability } : {}),
        ...metadata,
      },
    });
  }

  get stats(): { checks: number; denials: number } {
    return { checks: this.#checks, denials: this.#denials };
  }
}

function limitFor(limits: ResourceLimits, kind: ResourceLimitKind): number | undefined {
  switch (kind) {
    case "outputBytes":
      return limits.maxOutputBytes;
    case "fileReadBytes":
      return limits.maxFileReadBytes;
    case "fileWriteBytes":
      return limits.maxFileWriteBytes;
    case "commandDurationMs":
      return limits.maxCommandDurationMs;
  }
}

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsJson || "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function pathArg(args: Record<string, unknown>, fallback = ""): string {
  const value = args["path"];
  return typeof value === "string" ? value : fallback;
}

function commandArg(args: Record<string, unknown>): string {
  const value = args["command"];
  return typeof value === "string" ? value : "";
}

export type { RiskLevel };
