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
