import type { Capability } from "./types.js";

/**
 * Capabilities instead of booleans, so a sub-agent can be handed a narrowed
 * set and cannot widen it.
 *
 * The rule that matters: a child may only ever receive the *intersection* of
 * what it asks for and what its parent holds. There is no API that adds a
 * capability the parent lacks.
 */
export class CapabilitySet {
  readonly #granted: Set<Capability>;

  constructor(capabilities: readonly Capability[] = []) {
    this.#granted = new Set(capabilities);
  }

  has(capability: Capability): boolean {
    return this.#granted.has(capability);
  }

  grant(capability: Capability): void {
    this.#granted.add(capability);
  }

  revoke(capability: Capability): void {
    this.#granted.delete(capability);
  }

  list(): Capability[] {
    return [...this.#granted].sort();
  }

  get size(): number {
    return this.#granted.size;
  }

  /**
   * Narrow for a child. Requested capabilities the parent does not hold are
   * dropped, not granted — attempting to obtain them is simply ineffective.
   */
  intersect(requested: readonly Capability[]): CapabilitySet {
    return new CapabilitySet(requested.filter((c) => this.#granted.has(c)));
  }

  /** Capabilities in `requested` that the parent lacks (for audit/escalation warnings). */
  escalationAttempts(requested: readonly Capability[]): Capability[] {
    return requested.filter((c) => !this.#granted.has(c));
  }
}

/** Capabilities granted at each mode before any narrowing. */
export function capabilitiesForMode(mode: "restricted" | "workspace" | "permissive"): Capability[] {
  switch (mode) {
    case "restricted":
      return ["filesystem.read", "filesystem.write", "environment.read_safe"];

    case "workspace":
      return [
        "filesystem.read",
        "filesystem.write",
        "filesystem.delete",
        "process.execute",
        "environment.read_safe",
        "mcp.use",
        "agent.spawn",
      ];

    case "permissive":
      return [
        "filesystem.read",
        "filesystem.write",
        "filesystem.delete",
        "filesystem.execute",
        "process.execute",
        "process.network",
        "environment.read",
        "environment.read_safe",
        "mcp.use",
        "agent.spawn",
      ];
  }
}

/**
 * Baseline for a sub-agent that did not ask for anything specific: a safe
 * subset inherited from the parent, never the parent's full set.
 */
export function defaultChildCapabilities(parent: CapabilitySet): CapabilitySet {
  return parent.intersect([
    "filesystem.read",
    "filesystem.write",
    "environment.read_safe",
    "mcp.use",
  ]);
}
