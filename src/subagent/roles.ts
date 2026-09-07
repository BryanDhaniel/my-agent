/**
 * Role presets.
 *
 * A role is deliberately thin: it picks system instructions, a tool
 * allowlist and optional skills. It never adds branching behaviour — a
 * Sub-Agent runs the same Agent loop as the parent regardless of role.
 *
 * Roles reuse the existing Skills system for depth; they are not a second
 * prompt framework.
 */

export interface RolePreset {
  readonly description: string;
  readonly system: string;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
}

export const ALL_NATIVE_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "run_bash",
  "glob",
  "grep",
] as const;

const READ_ONLY_TOOLS = ["read_file", "glob", "grep"] as const;

export const ROLE_PRESETS: Record<string, RolePreset> = {
  general: {
    description: "General-purpose assistant with full tool access",
    system:
      "You are a focused sub-agent. Complete the delegated task using the " +
      "tools available to you. Be concrete and concise; report only what " +
      "matters for the task.",
    tools: ALL_NATIVE_TOOLS,
    skills: [],
  },
  researcher: {
    description: "Investigates the codebase and reports findings (read-only)",
    system:
      "You are a research sub-agent. Investigate the codebase and report " +
      "findings with concrete file paths and line references. You are " +
      "read-only: never modify files or run mutating commands.",
    tools: READ_ONLY_TOOLS,
    skills: [],
  },
  coder: {
    description: "Implements changes across files",
    system:
      "You are an implementation sub-agent. Make the smallest correct change " +
      "that completes the task. Prefer editing existing files over creating " +
      "new ones, and keep the codebase consistent.",
    tools: ALL_NATIVE_TOOLS,
    skills: [],
  },
  reviewer: {
    description: "Reviews changes and reports issues (read-only)",
    system:
      "You are a code review sub-agent. Identify correctness, clarity and " +
      "maintainability problems, ordered by severity, each with a file " +
      "reference and a concrete suggestion. You are read-only: do not modify " +
      "anything.",
    tools: READ_ONLY_TOOLS,
    skills: [],
  },
  debugger: {
    description: "Diagnoses failures and root causes",
    system:
      "You are a debugging sub-agent. Reproduce the failure, isolate the " +
      "root cause, and explain it precisely. You may run read-only shell " +
      "commands to inspect the system; ask before changing anything.",
    tools: ["read_file", "glob", "grep", "run_bash"],
    skills: [],
  },
  planner: {
    description: "Produces an ordered implementation plan (read-only)",
    system:
      "You are a planning sub-agent. Explore first, then produce an ordered, " +
      "concrete plan: the files to touch, the change in each, and the risks. " +
      "You are read-only: produce the plan, do not implement it.",
    tools: READ_ONLY_TOOLS,
    skills: [],
  },
  "security-reviewer": {
    description: "Audits for security weaknesses (read-only)",
    system:
      "You are a security review sub-agent. Look for injection, " +
      "authentication and authorization flaws, unsafe input handling, secret " +
      "leakage, and dependency risk. Report each finding with severity, a " +
      "file reference, and a remediation. You are read-only: never modify " +
      "files or exfiltrate secrets.",
    tools: READ_ONLY_TOOLS,
    skills: [],
  },
};

export const DEFAULT_ROLE = "general";

export function roleNames(): string[] {
  return Object.keys(ROLE_PRESETS).sort();
}

/** Undefined when the role is unknown, so callers can report it precisely. */
export function resolveRole(name: string | undefined): RolePreset | undefined {
  if (name === undefined || name === "") return ROLE_PRESETS[DEFAULT_ROLE];
  return ROLE_PRESETS[name];
}
