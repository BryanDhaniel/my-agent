import path from "node:path";
import { isPathInside } from "./paths.js";
import type { CapabilitySet } from "./capabilities.js";
import type { CommandSecurityPolicy, RiskLevel, SecurityDecision, SecurityMode } from "./types.js";

/**
 * Shell command security.
 *
 * The whole command is analyzed, not just its first token: `echo ok && rm -rf /`
 * must not inherit `echo`'s safety. Chaining, piping, redirection and command
 * substitution are detected and every segment classified; the overall verdict
 * is the worst segment.
 *
 * This is an application-level policy boundary, not OS-level isolation.
 */

export type CommandClass = "safe" | "caution" | "dangerous" | "forbidden";

const CLASS_RISK: Record<CommandClass, RiskLevel> = {
  safe: "low",
  caution: "medium",
  dangerous: "high",
  forbidden: "critical",
};

/**
 * Severity order used when reducing per-segment classes to one verdict.
 *
 * This must be numeric. Comparing the risk *strings* is a trap: "critical" >
 * "low" is false under lexicographic ordering, which silently downgraded
 * forbidden commands to safe.
 */
const CLASS_ORDER: Record<CommandClass, number> = {
  safe: 0,
  caution: 1,
  dangerous: 2,
  forbidden: 3,
};

/** Constructs that change what actually executes. */
const CHAIN_TOKENS = /(;|&&|\|\||\||>>|>|<|&|\n|\r)/;
const SUBSTITUTION = /(\$\(|`|\$\{)/;

const FORBIDDEN: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*(-rf?|--recursive|--force).*(\/\s*$|\/$)/i,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/|\*|~)(\s|$)/i,
  /\b(mkfs|format|diskpart)\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /:\s*\(\s*\)\s*\{/,
  /\breg\s+delete\b/i,
  /\bnet\s+user\b/i,
  /\bInvoke-Expression\b|\biex\b/i,
  /\b(curl|wget)\b[^\n]*\|\s*(ba|z|k)?sh\b/i,
  /\bchmod\s+(-R\s+)?777\s+\//i,
  /\bdel\s+\/[a-z]*\s*\/[a-z]*s/i,
  /\bRemove-Item\b[^\n]*-Recurse[^\n]*(C:\\|^\/)/i,
  /\b(vssadmin\s+delete\s+shadows|wmic\s+process\s+call\s+create)\b/i,
  /\bgit\s+push\b[^\n]*--force/i,
];

const DANGEROUS: RegExp[] = [
  /^(\s*)(rm|rmdir|del|rd|erase|shred|truncate)\b/i,
  /\b(kill|killall|taskkill|Stop-Process)\b/i,
  /\b(chmod|chown|attrib|takeown|icacls|sudo|su)\b/i,
  /\bgit\s+(clean\s+-fd?|reset\s+--hard)\b/i,
  /** Any recursive delete is destructive, even when it stays in the workspace. */
  /\bRemove-Item\b[^\n]*-Recurse/i,
];

const CAUTION: RegExp[] = [
  /\b(npm|pnpm|yarn)\s+(install|ci|add|update|remove)\b/i,
  /\bpip\s+install\b/i,
  /\b(cargo|go|dotnet|make)\s+build\b/i,
  /\bdocker\s+(build|run|pull|push)\b/i,
  /\bgit\s+(checkout|reset|commit|push|merge|rebase|restore)\b/i,
  /\bnpm\s+(install|publish)\b/i,
];

const SAFE: RegExp[] = [
  /\bgit\s+(status|diff|log|show|branch|rev-parse|remote\s+-v)\b/i,
  /^(ls|dir|pwd|cd|cat|type|echo|head|tail|wc|sort|uniq|which|where)\b/i,
  /\bgrep\b/i,
  /\bfind\b/i,
  /\b(npm|pnpm|yarn)\s+(test|run)\b/i,
  /\btsc(\s+--noEmit)?\b/i,
  /\bnode\s+(-v|--version)\b/i,
  /\bvitest\b/i,
];

/**
 * Commands that reach the network. Package managers are deliberately absent:
 * installing dependencies is ordinary work in `workspace` mode, and gating it
 * on the network policy would break the common case without adding safety.
 */
const NETWORKY: RegExp[] = [
  /\b(curl|wget|ssh|scp|rsync|nc|telnet)\b/i,
  /\bdocker\s+(pull|push)\b/i,
  /\bgit\s+(clone|fetch|pull|push)\b/i,
];

export interface CommandAnalysis {
  classification: CommandClass;
  riskLevel: RiskLevel;
  executables: string[];
  chained: boolean;
  substituted: boolean;
  redirected: boolean;
  usesNetwork: boolean;
  reason: string;
}

/** Split a command into independently classifiable segments. */
export function splitSegments(command: string): string[] {
  return command
    .replace(/\$\(([^)]*)\)/g, " ; $1 ; ")
    .replace(/`([^`]*)`/g, " ; $1 ; ")
    .replace(/\$\{([^}]*)\}/g, " ; $1 ; ")
    .split(/;|&&|\|\||\||\n|\r/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Best-effort executable name for a segment (ignores env assignments). */
export function executableOf(segment: string): string {
  const withoutRedirect = segment.replace(/[<>].*$/, "").trim();
  const tokens = withoutRedirect.split(/\s+/).filter((t) => t !== "");
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // VAR=value prefix
    return token.replace(/^["']|["']$/g, "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  }
  return "";
}

function classifySegment(segment: string): CommandClass {
  if (FORBIDDEN.some((p) => p.test(segment))) return "forbidden";
  const executable = executableOf(segment);
  if (executable !== "" && DANGEROUS.some((p) => p.test(segment))) return "dangerous";
  if (CAUTION.some((p) => p.test(segment))) return "caution";
  if (SAFE.some((p) => p.test(segment))) return "safe";
  return "caution"; // unknown: fail closed
}

export function analyzeCommand(command: string): CommandAnalysis {
  const segments = splitSegments(command);
  const executables = segments.map(executableOf).filter((e) => e !== "");

  let classification: CommandClass = "safe";
  for (const segment of segments) {
    const segmentClass = classifySegment(segment);
    if (CLASS_ORDER[segmentClass] > CLASS_ORDER[classification]) classification = segmentClass;
  }

  const redirected = /[<>](?!\s*$)/.test(command);
  const substituted = SUBSTITUTION.test(command);
  const chained = CHAIN_TOKENS.test(command) || segments.length > 1;
  const usesNetwork = NETWORKY.some((p) => p.test(command));

  // A safe command that is chained, substituted or redirected is no longer
  // plainly safe — treat it as at least caution so a human confirms.
  if (classification === "safe" && (chained || substituted || redirected)) {
    classification = "caution";
  }

  const reason =
    classification === "forbidden"
      ? "forbidden command pattern detected"
      : classification === "dangerous"
        ? "destructive command detected"
        : classification === "caution"
          ? chained || substituted || redirected
            ? "command uses chaining, substitution or redirection"
            : "command is not on the known-safe list"
          : "known-safe command";

  return {
    classification,
    riskLevel: CLASS_RISK[classification],
    executables,
    chained,
    substituted,
    redirected,
    usesNetwork,
    reason,
  };
}

/**
 * Commands whose entire job is "print this file". For these, a path argument
 * outside the workspace is treated as an escape rather than as ordinary
 * shell work — `cat ~/.my-agent/credentials.json` must not be allowed just
 * because `cat` is on the safe list.
 */
const FILE_READERS = new Set(["cat", "type", "head", "tail", "more", "less", "bat"]);

/** First path argument that resolves outside every allowed root, if any. */
export function outsideFileTarget(
  command: string,
  cwd: string,
  allowedRoots: readonly string[],
): string | undefined {
  const segments = splitSegments(command);
  for (const segment of segments) {
    const executable = executableOf(segment);
    if (!FILE_READERS.has(executable)) continue;

    for (const token of segment.split(/\s+/).slice(1)) {
      if (token === "" || token.startsWith("-")) continue;
      if (!/[\\/]/.test(token)) continue; // relative names stay in the cwd
      const resolved = path.resolve(cwd, token.replace(/^["']|["']$/g, ""));
      const inside =
        allowedRoots.some((root) => isPathInside(root, resolved)) ||
        isPathInside(cwd, resolved);
      if (!inside) return resolved;
    }
  }
  return undefined;
}

export interface CommandDecision extends SecurityDecision {
  analysis: CommandAnalysis;
}

export function checkCommandAccess(input: {
  command: string;
  cwd: string;
  workspaceRoot: string;
  policy: CommandSecurityPolicy;
  capabilities: CapabilitySet;
  mode?: SecurityMode;
}): CommandDecision {
  const { command, cwd, workspaceRoot, policy, capabilities, mode = "workspace" } = input;
  const analysis = analyzeCommand(command);

  const deny = (reason: string, riskLevel: RiskLevel): CommandDecision => ({
    allowed: false,
    requiresConfirmation: false,
    reason,
    riskLevel,
    capability: "process.execute",
    analysis,
  });

  if (!capabilities.has("process.execute")) {
    return deny('blocked: missing capability "process.execute"', "high");
  }
  if (!policy.allowProcessSpawn) {
    return deny("process execution is disabled by the command policy", "high");
  }

  const cwdAllowed =
    isPathInside(workspaceRoot, cwd) ||
    policy.allowedWorkingDirectories.some((root) => isPathInside(root, cwd));
  if (!cwdAllowed) {
    return deny("working directory is outside the workspace", "critical");
  }

  const executable = analysis.executables[0] ?? "";
  if (executable !== "" && policy.deniedCommands.includes(executable)) {
    return deny(`command "${executable}" is denied by policy`, "critical");
  }

  const escapedTarget = outsideFileTarget(command, cwd, [
    workspaceRoot,
    ...policy.allowedWorkingDirectories,
  ]);
  if (escapedTarget !== undefined) {
    return deny("command reads a file outside the workspace", "critical");
  }

  if (analysis.classification === "forbidden") {
    return deny(`blocked: ${analysis.reason}`, "critical");
  }

  if (analysis.usesNetwork && !policy.allowNetwork && !capabilities.has("process.network")) {
    return deny("network access is disabled by the command policy", "high");
  }

  if (analysis.classification === "dangerous") {
    // Permissive still asks; it never silently allows destruction.
    return {
      allowed: false,
      requiresConfirmation: mode === "permissive",
      reason: `${analysis.reason} — requires explicit authorization`,
      riskLevel: "critical",
      capability: "process.execute",
      analysis,
    };
  }

  if (analysis.classification === "caution") {
    return {
      allowed: true,
      requiresConfirmation: true,
      reason: analysis.reason,
      riskLevel: "medium",
      capability: "process.execute",
      analysis,
    };
  }

  return {
    allowed: true,
    requiresConfirmation: false,
    reason: analysis.reason,
    riskLevel: "low",
    capability: "process.execute",
    analysis,
  };
}
