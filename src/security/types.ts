/**
 * Security model.
 *
 * The LLM is not trusted: it may *request* an operation, but the
 * SecurityManager decides whether it happens. Every path (files, shell, MCP,
 * sub-agents) funnels through one set of checks.
 */

export type SecurityMode = "restricted" | "workspace" | "permissive";

export type Capability =
  | "filesystem.read"
  | "filesystem.write"
  | "filesystem.delete"
  | "filesystem.execute"
  | "process.execute"
  | "process.network"
  | "environment.read"
  | "environment.read_safe"
  | "mcp.use"
  | "mcp.admin"
  | "agent.spawn"
  | "agent.escalate";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface FilesystemPolicy {
  /** Extra read-permitted roots beyond the workspace. */
  allowedReadPaths: string[];
  /** Extra write-permitted roots beyond the workspace. */
  allowedWritePaths: string[];
  /** Always denied, workspace or not. */
  deniedPaths: string[];
  allowDelete: boolean;
  allowSymlinks: boolean;
}

export interface CommandSecurityPolicy {
  /** Executables always permitted (bare name, e.g. "git"). */
  allowedCommands: string[];
  /** Executables always refused. */
  deniedCommands: string[];
  /** Working directories the shell may run in; defaults to the workspace. */
  allowedWorkingDirectories: string[];
  allowNetwork: boolean;
  allowProcessSpawn: boolean;
}

export interface EnvironmentPolicy {
  allowedVariables: string[];
  deniedVariables: string[];
  /** Allow non-secret variables to be read by the agent. */
  allowSafeVariables: boolean;
}

export interface MCPPolicy {
  allowedServers: string[];
  allowedTools: string[];
  deniedTools: string[];
}

export interface ResourceLimits {
  maxCommandDurationMs?: number;
  maxOutputBytes?: number;
  maxFileReadBytes?: number;
  maxFileWriteBytes?: number;
  maxConcurrentProcesses?: number;
}

export interface SecurityPolicy {
  mode: SecurityMode;
  workspaceRoot: string;
  filesystem: FilesystemPolicy;
  commands: CommandSecurityPolicy;
  environment: EnvironmentPolicy;
  mcp: MCPPolicy;
  limits: ResourceLimits;
}

export interface SecurityContext {
  /** Stable id for this execution, tied to the observability run tree. */
  executionId: string;
  parentExecutionId?: string;
  runId?: string;
  mode: SecurityMode;
  workspaceRoot: string;
  capabilities: import("./capabilities.js").CapabilitySet;
  policy: SecurityPolicy;
  /** Human label for audit lines, e.g. "researcher". */
  label?: string;
}

export interface SecurityDecision {
  allowed: boolean;
  /** Allowed by policy, but the user must confirm via the permission gate. */
  requiresConfirmation: boolean;
  reason: string;
  riskLevel: RiskLevel;
  capability?: Capability;
}

/** Errors are normalized so callers can report a useful reason, not "denied". */
export class SecurityError extends Error {
  readonly riskLevel: RiskLevel;
  readonly reason: string;

  constructor(reason: string, riskLevel: RiskLevel = "high") {
    super(reason);
    this.name = "SecurityError";
    this.reason = reason;
    this.riskLevel = riskLevel;
  }
}

export class SandboxViolationError extends SecurityError {
  constructor(reason: string) {
    super(reason, "critical");
    this.name = "SandboxViolationError";
  }
}

export class CapabilityError extends SecurityError {
  constructor(capability: Capability) {
    super(`missing capability "${capability}"`, "high");
    this.name = "CapabilityError";
  }
}

export const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}
