/**
 * Deterministic priority for context selection.
 *
 * Every candidate for the request is a ContextItem carrying a numeric
 * priority. Selection is a stable sort by priority (descending) followed by a
 * greedy fill, so the same context always produces the same request:
 *
 *   system instructions  >  compacted summary  >  active task  >
 *   permissions  >  active skills  >  memories  >  newest Turn Group … oldest
 *
 * Turn Groups decay linearly with age so the newest exchange always outranks
 * older ones, and a group is never split — a Tool Result stays attached to
 * the Tool Call that produced it.
 */

import type { ChatMessage } from "../agent/types.js";

export type ContextItemKind =
  | "system"
  | "summary"
  | "task"
  | "permissions"
  | "skill"
  | "memory"
  | "conversation";

/** Base priority per kind; conversation is scaled by age on top of this. */
export const CONTEXT_PRIORITY: Record<ContextItemKind, number> = {
  system: 1_000,
  summary: 950,
  task: 900,
  permissions: 850,
  skill: 800,
  memory: 700,
  conversation: 500,
};

/** The oldest Turn Group still ranks above nothing, the newest at 500. */
export const CONVERSATION_PRIORITY_NEWEST = 500;
export const CONVERSATION_PRIORITY_OLDEST = 100;

export interface ContextItem {
  /** Stable identity — used for dedupe and test assertions. */
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly priority: number;
  readonly tokens: number;
  readonly messages: readonly ChatMessage[];
  /** False for items that must survive even an exhausted budget. */
  readonly droppable: boolean;
  /** Human-readable label, used for token accounting. */
  readonly label?: string;
}

/**
 * Split a conversation into Turn Groups: a user message plus every
 * assistant/tool message it triggered. Keeping groups intact is what stops a
 * Tool Result from being separated from the Tool Call that produced it.
 */
export function splitIntoGroups(messages: readonly ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || groups.length === 0) {
      groups.push([message]);
    } else {
      groups[groups.length - 1]?.push(message);
    }
  }
  return groups;
}

/**
 * Priority for a Turn Group: `age` counts backwards from the newest group
 * (0 = newest). Groups are ordered oldest-first in the array.
 */
export function conversationPriority(age: number, total: number): number {
  if (total <= 1) return CONVERSATION_PRIORITY_NEWEST;
  const clamped = Math.min(Math.max(age, 0), total - 1);
  const t = clamped / (total - 1);
  const span = CONVERSATION_PRIORITY_NEWEST - CONVERSATION_PRIORITY_OLDEST;
  return Math.round(CONVERSATION_PRIORITY_NEWEST - span * t);
}

/** Stable sort: higher priority first, ties keep insertion order. */
export function byPriority(items: readonly ContextItem[]): ContextItem[] {
  return [...items].sort((a, b) => b.priority - a.priority);
}

export interface SelectionResult {
  /** Items that made it into the request, in canonical (emission) order. */
  readonly kept: readonly ContextItem[];
  readonly dropped: readonly ContextItem[];
  /** Estimated tokens spent by the kept items. */
  readonly used: number;
}

export interface SelectionOptions {
  /** Total tokens available for input. */
  readonly input: number;
  /** Per-kind ceilings; a kind without an entry is limited only by `input`. */
  readonly caps: Readonly<Record<string, number>>;
  /**
   * Reduces an oversized item to fit `cap` (e.g. by truncating a Tool
   * Result). Returns undefined when the item cannot be made to fit.
   */
  readonly shrink?: (item: ContextItem, cap: number) => ContextItem | undefined;
}

/**
 * Greedy fill in priority order.
 *
 * Each item is capped by its section ceiling and by whatever input is left.
 * Conversation items — which sit last in priority — effectively absorb the
 * slack of every section that did not spend its share. Non-droppable items
 * survive an exhausted budget; everything else is dropped whole.
 */
export function selectWithinBudget(
  items: readonly ContextItem[],
  options: SelectionOptions,
): SelectionResult {
  const { input, caps, shrink } = options;
  const kept = new Map<string, ContextItem>();
  const dropped: ContextItem[] = [];
  let remaining = Math.max(0, input);

  for (const item of byPriority(items)) {
    const cap = Math.min(caps[item.kind] ?? input, input);
    let candidate: ContextItem | undefined = item;

    if (item.tokens > Math.min(cap, remaining)) {
      candidate = shrink?.(item, Math.min(cap, remaining));
    }

    if (candidate === undefined) {
      if (!item.droppable) {
        // Never silently lose the system prompt or the newest Turn Group.
        kept.set(item.id, item);
        remaining = Math.max(0, remaining - item.tokens);
      } else {
        dropped.push(item);
      }
      continue;
    }

    kept.set(candidate.id, candidate);
    remaining = Math.max(0, remaining - candidate.tokens);
  }

  // Re-emit in canonical order (registration order, then conversation order).
  const ordered = items.filter((item) => kept.has(item.id)).map((item) => kept.get(item.id)!);
  const used = ordered.reduce((sum, item) => sum + item.tokens, 0);

  return { kept: ordered, dropped, used };
}
