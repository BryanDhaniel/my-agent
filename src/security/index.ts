import { capabilitiesForMode } from "./capabilities.js";
import type { SecurityMode, SecurityPolicy } from "./types.js";

export * from "./types.js";
export * from "./capabilities.js";
export * from "./paths.js";
export * from "./commands.js";
export * from "./environment.js";
export * from "./manager.js";

/**
 * Fail-closed defaults. When nothing is configured the agent gets the
 * narrowest useful policy, never an open one.
 */
export function defaultSecurityPolicy(
  workspaceRoot: string,
  mode: SecurityMode = "workspace",
): SecurityPolicy {
  return {
    mode,
    workspaceRoot,
    filesystem: {
      allowedReadPaths: [],
      allowedWritePaths: [],
      deniedPaths: [],
      allowDelete: mode === "permissive",
      allowSymlinks: false,
    },
    commands: {
      allowedCommands: [],
      deniedCommands: [],
      allowedWorkingDirectories: [],
      allowNetwork: mode === "permissive",
      allowProcessSpawn: true,
    },
    environment: {
      allowedVariables: [],
      deniedVariables: [],
      allowSafeVariables: true,
    },
    mcp: {
      allowedServers: [],
      allowedTools: [],
      deniedTools: [],
    },
    limits: {
      maxCommandDurationMs: 30_000,
      maxOutputBytes: 10_000,
      maxFileReadBytes: 256 * 1024,
      maxFileWriteBytes: 1024 * 1024,
      maxConcurrentProcesses: 4,
    },
  };
}

export { capabilitiesForMode };

const SECURITY_MODES: readonly SecurityMode[] = ["restricted", "workspace", "permissive"];

export function isSecurityMode(value: string): value is SecurityMode {
  return (SECURITY_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the mode from the CLI flag, then the environment, then the default.
 *
 * An unrecognised value is an error rather than a silent fallback: guessing
 * here would either open the agent up or break it in a confusing way.
 */
export function resolveSecurityMode(raw?: string): SecurityMode {
  const value = raw ?? process.env["MY_AGENT_SECURITY_MODE"];
  if (value === undefined || value === "") return "workspace";
  if (!isSecurityMode(value)) {
    throw new Error(
      `Unknown security mode "${value}" — expected ${SECURITY_MODES.join(" | ")}`,
    );
  }
  return value;
}
