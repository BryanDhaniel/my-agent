import type { ChatMessage } from "../agent/types.js";

/** Rough token estimate: ~4 characters per token for English/code mixtures. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageTokens(m: ChatMessage): number {
  switch (m.role) {
    case "system":
    case "user":
    case "assistant":
      return estimateTokens(m.content);
    case "tool":
      return estimateTokens(m.content);
  }
}

/**
 * Keeps requests inside the model's context window without corrupting the
 * conversation structure:
 * - system messages always survive
 * - eviction is by whole Turn Groups (a user message plus every assistant /
 *   tool message it triggered), so a Tool Result is never separated from
 *   its Tool Call
 * - persistence stays complete: trimming happens only for what we send
 */
export class ContextManager {
  readonly maxTokens: number;

  constructor(maxTokens = 96_000) {
    this.maxTokens = maxTokens;
  }

  trimForRequest(history: ChatMessage[]): ChatMessage[] {
    const system = history.filter((m) => m.role === "system");
    const rest = history.filter((m) => m.role !== "system");

    const groups = splitIntoGroups(rest);
    const cost = (list: ChatMessage[]): number =>
      list.reduce((sum, m) => sum + messageTokens(m), 0);

    const systemCost = cost(system);
    let kept = groups;

    // Drop oldest groups until we fit; always keep at least the newest group.
    while (kept.length > 1 && systemCost + cost(kept.flat()) > this.maxTokens) {
      kept = kept.slice(1);
    }

    return [...system, ...kept.flat()];
  }
}

function splitIntoGroups(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const m of messages) {
    if (m.role === "user" || groups.length === 0) {
      groups.push([m]);
    } else {
      groups[groups.length - 1]?.push(m);
    }
  }
  return groups;
}
