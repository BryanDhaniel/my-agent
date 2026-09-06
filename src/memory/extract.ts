/**
 * Memory extraction — deciding what a run is worth remembering.
 *
 * Deliberately conservative. The failure mode we care about is a memory store
 * full of tool output and half-finished chatter, so extraction only fires on
 * explicit, durable-sounding statements from the user (and, for the narrow
 * decision pattern, from the agent). Everything else — Tool Results, transient
 * reasoning, ordinary requests — is left in the Session where it belongs.
 *
 * Rules are ordered: the first pattern that matches a sentence wins, so a
 * sentence is never filed under two categories.
 */

import type { ChatMessage } from "../agent/types.js";
import { MIN_MEMORY_CHARS, type Importance, type MemoryCategory } from "./types.js";
import { containsSecrets } from "./sanitize.js";
import { contentKey } from "./manager.js";

export interface MemoryCandidate {
  readonly content: string;
  readonly category: MemoryCategory;
  readonly importance: Importance;
}

export interface ExtractionInput {
  /** Messages produced by the run — typically the user turn plus the additions. */
  readonly messages: readonly ChatMessage[];
  /** Recorded as each memory's `source`. */
  readonly sessionId: string;
}

/** Long sentences are prose, not knowledge. */
const MAX_CANDIDATE_CHARS = 240;
/** One run should not flood the store. */
const MAX_CANDIDATES_PER_RUN = 5;

interface Rule {
  readonly category: MemoryCategory;
  readonly importance: Importance;
  readonly pattern: RegExp;
}

/** Checked in order; the first match wins. */
const RULES: readonly Rule[] = [
  {
    category: "fact",
    importance: 5,
    pattern:
      /\b(remember (?:that|this|to)|save (?:this|that) (?:to|as|in) memory|add (?:this|that) to memory|keep this in mind)\b/i,
  },
  {
    category: "decision",
    importance: 5,
    pattern:
      /\b(we(?:'ll| will| should| decided to)? (?:use|go with|adopt|stick with|keep)|let's use|decided|decision is|going with|instead of)\b/i,
  },
  {
    category: "preference",
    importance: 4,
    pattern: /\b(always|never|prefer|from now on|by default|don't|do not)\b/i,
  },
  {
    category: "project",
    importance: 4,
    pattern: /\b(convention|we use|the project uses|our (?:style|stack|setup|naming)|house style|standard here)\b/i,
  },
  {
    category: "architecture",
    importance: 4,
    pattern: /\b(architecture|the (?:boundary|seam|layer) (?:is|between|between)|owns|ownership|pipeline)\b/i,
  },
  {
    category: "debugging",
    importance: 3,
    pattern: /\b(root cause|the bug was|turned out|the issue was|the fix was|workaround)\b/i,
  },
];

/** Only these rules are trusted when the agent (not the user) is speaking. */
const AGENT_RULE_CATEGORIES: readonly MemoryCategory[] = ["decision"];

export function extractMemoryCandidates(input: ExtractionInput): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  const seen = new Set<string>();

  for (const message of input.messages) {
    // Tool Results are transient by definition — never memory.
    if (message.role === "tool" || message.role === "system") continue;

    const agentSpeaking = message.role === "assistant";
    for (const sentence of sentences(message.content)) {
      if (out.length >= MAX_CANDIDATES_PER_RUN) return out;

      const rule = matchRule(sentence, agentSpeaking);
      if (rule === undefined) continue;
      if (containsSecrets(sentence)) continue;

      const key = contentKey(sentence);
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        content: sentence,
        category: rule.category,
        importance: agentSpeaking ? downgrade(rule.importance) : rule.importance,
      });
    }
  }

  return out;
}

function matchRule(sentence: string, agentSpeaking: boolean): Rule | undefined {
  for (const rule of RULES) {
    if (agentSpeaking && !AGENT_RULE_CATEGORIES.includes(rule.category)) continue;
    if (rule.pattern.test(sentence)) return rule;
  }
  return undefined;
}

/** Split a message into candidate sentences: newlines first, then punctuation. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("/")) continue; // slash commands are not knowledge
    if (trimmed.length > MAX_CANDIDATE_CHARS) continue;

    const normalized = trimmed.replace(/\s+/g, " ");
    if (normalized.endsWith("?")) continue; // a question is not a fact
    if (normalized.length < MIN_MEMORY_CHARS) continue;

    out.push(normalized);
  }
  return out;
}

function downgrade(importance: Importance): Importance {
  return importance > 1 ? ((importance - 1) as Importance) : importance;
}
