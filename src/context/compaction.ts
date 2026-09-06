/**
 * Compaction: shrink what the model sees without losing what mattered.
 *
 *   Large Context → [ keep newest Turn Groups ] + [ summarize the rest ] → Smaller Context
 *
 * The summary that replaces the dropped messages is produced by a Summarizer.
 * The default one is deterministic and needs no model call; an LLM-backed one
 * can be dropped in later without touching the Agent, the Harness, or the
 * Runtime — this is the only seam that knows anything might be summarized
 * by inference.
 */

import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import {
  emptySummary,
  extractFilePaths,
  makeSummary,
  mergeSummaries,
  type ContextSummary,
} from "./summary.js";

/** How much of the conversation budget the compacted context aims to use. */
export const DEFAULT_KEEP_SHARE = 0.5;
/** Newest Turn Groups that survive compaction no matter the budget. */
export const DEFAULT_PROTECTED_GROUPS = 2;

const TASK_MAX_CHARS = 240;
const LINE_MAX_CHARS = 160;

export interface CompactionInput {
  /** The messages being summarized away, oldest first. */
  readonly messages: readonly ChatMessage[];
  /** Summary produced by an earlier compaction of the same session. */
  readonly previous?: ContextSummary | undefined;
}

export interface Summarizer {
  summarize(input: CompactionInput): ContextSummary | Promise<ContextSummary>;
}

/**
 * Rule-based summarizer — no model call, no network, fully deterministic.
 *
 * It reads the messages it is given and lifts out the parts that survive a
 * context reset: the task, explicit decisions, stated conventions, actions
 * already taken, and errors hit along the way.
 */
export class ExtractiveSummarizer implements Summarizer {
  summarize(input: CompactionInput): ContextSummary {
    let task = "";
    const decisions: string[] = [];
    const importantFacts: string[] = [];
    const completedActions: string[] = [];
    const pendingActions: string[] = [];
    const discoveredIssues: string[] = [];
    const relevantFiles: string[] = [];

    for (const message of input.messages) {
      switch (message.role) {
        case "user": {
          const trimmed = message.content.trim();
          if (trimmed !== "") task = trim(trimmed, TASK_MAX_CHARS);
          for (const line of notableLines(trimmed, CONVENTION_PATTERN)) {
            push(importantFacts, line);
          }
          break;
        }
        case "assistant": {
          for (const line of notableLines(message.content, DECISION_PATTERN)) {
            push(decisions, line);
          }
          for (const line of notableLines(message.content, PENDING_PATTERN)) {
            push(pendingActions, line);
          }
          for (const action of describeToolCalls(message)) {
            push(completedActions, action);
          }
          break;
        }
        case "tool": {
          const first = message.content.trim();
          if (first !== "" && ERROR_PATTERN.test(first)) {
            push(discoveredIssues, first.split("\n")[0] ?? "");
          }
          for (const file of extractFilePaths(message.content)) {
            push(relevantFiles, file);
          }
          break;
        }
        case "system":
          break;
      }
    }

    return mergeSummaries(
      input.previous,
      makeSummary({
        task,
        decisions,
        importantFacts,
        completedActions,
        pendingActions,
        discoveredIssues,
        relevantFiles,
        coveredMessages: 0,
      }),
    );
  }
}

/** A summarizer that records nothing — used when compaction must stay silent. */
export class NoopSummarizer implements Summarizer {
  summarize(input: CompactionInput): ContextSummary {
    return mergeSummaries(input.previous, emptySummary());
  }
}

export interface CompactionPlanInput {
  /** Turn Groups, oldest first. */
  readonly groups: readonly (readonly ChatMessage[])[];
  /** Tokens available to the conversation after compaction. */
  readonly conversationBudget: number;
  /** Newest groups that are kept even when they overflow the target. */
  readonly protectedGroups?: number;
  /** Share of the conversation budget the compacted context should occupy. */
  readonly keepShare?: number;
  readonly tokens?: (messages: readonly ChatMessage[]) => number;
}

export interface CompactionPlan {
  /** How many leading Turn Groups are summarized away. */
  readonly summarizedGroups: number;
  /** The flattened messages handed to the Summarizer. */
  readonly summarized: readonly ChatMessage[];
}

/**
 * Decide how much of the conversation survives.
 *
 * Walks newest → oldest and keeps groups while they fit the target, always
 * protecting the most recent ones. Returns undefined when there is nothing
 * worth compacting (fewer than two groups, or everything already fits).
 */
export function planCompaction(input: CompactionPlanInput): CompactionPlan | undefined {
  if (input.groups.length < 2) return undefined;

  const target = Math.max(1, Math.floor(input.conversationBudget * (input.keepShare ?? DEFAULT_KEEP_SHARE)));
  const protectedGroups = Math.max(1, input.protectedGroups ?? DEFAULT_PROTECTED_GROUPS);
  const tokens =
    input.tokens ?? ((messages: readonly ChatMessage[]) =>
      messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0));

  let used = 0;
  let keep = 0;
  for (let i = input.groups.length - 1; i >= 0; i--) {
    const group = input.groups[i] ?? [];
    const cost = tokens(group);
    const isProtected = keep < protectedGroups;
    if (!isProtected && used + cost > target) break;
    if (keep >= input.groups.length - 1) break; // always leave something to summarize
    used += cost;
    keep++;
  }

  if (keep === 0) return undefined;

  const summarizedGroups = input.groups.length - keep;
  if (summarizedGroups <= 0) return undefined;

  return {
    summarizedGroups,
    summarized: input.groups.slice(0, summarizedGroups).flat(),
  };
}

// ── Pattern vocabulary ────────────────────────────────────────────

const CONVENTION_PATTERN =
  /\b(always|never|must|prefer|convention|by convention|we use|we don't|standard|rule)\b/i;
const DECISION_PATTERN =
  /\b(we(?:'ll| will| should)? (?:use|go with|choose|chose|adopt)|decided|decision|let's use|switch(?:ed|ing)? to|instead of|going with)\b/i;
const PENDING_PATTERN = /\b(next|todo|remaining|still need|will now|need to|before we)\b/i;
const ERROR_PATTERN = /\b(error|failed|denied|cannot|could not|not found|exception)\b/i;

function notableLines(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.length > LINE_MAX_CHARS) continue;
    if (!pattern.test(line)) continue;
    out.push(line);
  }
  return out;
}

function describeToolCalls(message: AssistantMessage): string[] {
  const out: string[] = [];
  for (const call of message.toolCalls ?? []) {
    out.push(trim(`${call.name}(${summarizeArgs(call.arguments)})`, LINE_MAX_CHARS));
  }
  return out;
}

function summarizeArgs(argsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argsJson || "{}");
    if (typeof parsed !== "object" || parsed === null) return String(parsed);
    const record = parsed as Record<string, unknown>;
    const primary = record["path"] ?? record["command"] ?? record["pattern"] ?? record["query"];
    return typeof primary === "string" ? trim(primary, 80) : "";
  } catch {
    return "";
  }
}

function push(list: string[], value: string): void {
  const trimmed = trim(value, LINE_MAX_CHARS);
  if (trimmed === "" || list.includes(trimmed)) return;
  list.push(trimmed);
}

function trim(text: string, max: number): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
