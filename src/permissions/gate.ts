export interface PermissionRequest {
  id: string;
  toolName: string;
  /** Human/LLM-readable summary of the requested action. */
  summary: string;
  /**
   * Session allowlist identity (tool-specific: command program, target
   * directory…). Requests sharing a key can be approved once with "always".
   */
  ruleKey?: string;
}

export type PermissionDecision = { allowed: true } | { allowed: false; reason: string };

export type PermissionResponse = "once" | "always" | "deny";

/** The slice of gate behavior the TUI needs. */
export interface UiGate {
  onPendingChange(listener: (pending: PermissionRequest[]) => void): void;
  respond(id: string, response: Exclude<PermissionResponse, "deny"> | "deny"): void;
  readonly allowedRules: readonly string[];
}

/** For --yolo and other prompt-less modes. */
export const NOOP_UI_GATE: UiGate = {
  onPendingChange: () => {},
  respond: () => {},
  allowedRules: [],
};

/** Runs before a mutating Tool Call executes. */
export interface PermissionGate {
  check(request: PermissionRequest): Promise<PermissionDecision>;
}

/** Approves everything — used by --yolo and tests. */
export class AutoApproveGate implements PermissionGate {
  async check(): Promise<PermissionDecision> {
    return { allowed: true };
  }
}

/** Denies everything — used by tests and as a safe fallback. */
export class DenyAllGate implements PermissionGate {
  async check(request: PermissionRequest): Promise<PermissionDecision> {
    return { allowed: false, reason: `permission denied for ${request.toolName}` };
  }
}

type Responder = (decision: PermissionDecision) => void;

interface PendingRequest extends PermissionRequest {
  resolve: Responder;
}

/**
 * Asks an attached listener (the UI) and remembers "always" answers for the
 * rest of the Session. With no UI attached it denies — never silently allow.
 */
export class AskUserGate implements PermissionGate, UiGate {
  #pending = new Map<string, PendingRequest>();
  #listener?: (pending: PermissionRequest[]) => void;
  #allowed = new Map<string, string>(); // ruleKey -> display label

  get pending(): PermissionRequest[] {
    return [...this.#pending.values()];
  }

  /** Human-readable rules granted with "always" this session, e.g. "npm". */
  get allowedRules(): readonly string[] {
    return [...this.#allowed.values()];
  }

  onPendingChange(listener: (pending: PermissionRequest[]) => void): void {
    this.#listener = listener;
  }

  async check(request: PermissionRequest): Promise<PermissionDecision> {
    if (
      request.ruleKey !== undefined &&
      this.#allowed.has(this.#key(request))
    ) {
      return { allowed: true };
    }
    return new Promise((resolve) => {
      this.#pending.set(request.id, { ...request, resolve });
      this.#listener?.(this.pending);
    });
  }

  respond(id: string, response: PermissionResponse): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);

    if (response === "always" && pending.ruleKey !== undefined) {
      this.#allowed.set(
        this.#key(pending),
        pending.ruleKey === "(project root)"
          ? `${pending.toolName} at project root`
          : pending.ruleKey,
      );
    }
    pending.resolve(
      response === "deny"
        ? { allowed: false, reason: "the user declined" }
        : { allowed: true },
    );
    this.#listener?.(this.pending);
  }

  #key(request: PermissionRequest): string {
    return `${request.toolName}:${request.ruleKey}`;
  }
}

/** Permission modes the TUI can cycle through with shift+tab. */
export type PermissionMode = "auto" | "manual" | "plan";

/** Cycle order for shift+tab. */
export const PERMISSION_MODES: readonly PermissionMode[] = ["auto", "manual", "plan"];

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const i = PERMISSION_MODES.indexOf(mode);
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length] ?? "auto";
}

/**
 * A permission gate whose behaviour is switchable at runtime (shift+tab).
 *
 * - `auto`   — approve every mutating call; same as `--yolo`.
 * - `manual` — ask the user; delegates to the wrapped `AskUserGate`.
 * - `plan`   — refuse mutations, telling the agent to propose a plan first.
 *
 * It also implements `UiGate`, so one object backs both the harness and the
 * TUI (which renders the prompts and the current mode).
 */
export class ModeGate implements PermissionGate, UiGate {
  #mode: PermissionMode;
  #ask: AskUserGate;

  constructor(mode: PermissionMode = "manual", ask: AskUserGate = new AskUserGate()) {
    this.#mode = mode;
    this.#ask = ask;
  }

  get mode(): PermissionMode {
    return this.#mode;
  }

  setMode(mode: PermissionMode): void {
    this.#mode = mode;
  }

  // ── UiGate (forwarded to the inner AskUserGate) ──
  onPendingChange(listener: (pending: PermissionRequest[]) => void): void {
    this.#ask.onPendingChange(listener);
  }

  respond(id: string, response: PermissionResponse): void {
    this.#ask.respond(id, response);
  }

  get allowedRules(): readonly string[] {
    return this.#ask.allowedRules;
  }

  // ── PermissionGate ──
  async check(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.#mode === "auto") return { allowed: true };
    if (this.#mode === "plan") {
      return {
        allowed: false,
        reason:
          "plan mode is on: do not run mutating tools. Describe the plan and wait for the user to switch modes.",
      };
    }
    return this.#ask.check(request);
  }
}
