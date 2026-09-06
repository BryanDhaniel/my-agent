/**
 * ContextManager — decides what the LLM sees for one request.
 *
 * It owns no conversation. The Harness owns the history (and persists it);
 * the ContextManager is handed that history plus the non-persisted context
 * sources — system instructions, active task, permission constraints, active
 * Skills, retrieved memories — and returns a message list that fits the
 * model's context window.
 *
 *   Session/Memory/Skills → ContextManager → Provider
 *
 * Two entry points:
 * - `buildContext(history)` — the full assembly, budget-aware.
 * - `trimForRequest(history)` — the historical shape, kept for callers that
 *   only want the conversation trimmed against `maxTokens`.
 */

import type { ChatMessage } from "../agent/types.js";
import {
  budgetCaps,
  resolveBudget,
  type ContextBudget,
  type ContextBudgetSpec,
} from "./budget.js";
import {
  CONTEXT_PRIORITY,
  conversationPriority,
  selectWithinBudget,
  splitIntoGroups,
  type ContextItem,
} from "./priority.js";
import {
  ExtractiveSummarizer,
  planCompaction,
  type Summarizer,
} from "./compaction.js";
import { isEmptySummary, renderSummary, type ContextSummary } from "./summary.js";

/** Rough token estimate: ~4 characters per token for English/code mixtures. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function messageTokens(message: ChatMessage): number {
  return estimateTokens(message.content);
}

export function tokensOf(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

/** An active Skill's instructions, offered to the Context Manager. */
export interface SkillContext {
  readonly name: string;
  readonly instructions: string;
}

/** A retrieved memory, offered to the Context Manager. */
export interface MemoryContext {
  readonly id?: string;
  readonly content: string;
  readonly category?: string;
  readonly importance?: number;
}

export interface ContextManagerOptions extends ContextBudgetSpec {
  /** Produces the summary used by compaction. Defaults to ExtractiveSummarizer. */
  summarizer?: Summarizer;
  /** Longest Tool Result kept in a request before it is truncated. */
  maxToolResultChars?: number;
  /** Fraction of the conversation budget that triggers compaction. */
  compactThreshold?: number;
  /** Newest Turn Groups compaction always keeps. */
  protectedGroups?: number;
  /** Share of the conversation budget the compacted context aims for. */
  keepShare?: number;
}

export const DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000;
const DEFAULT_COMPACT_THRESHOLD = 0.9;
/** Below this a truncated Tool Result carries no signal, so drop it instead. */
const MIN_TOOL_RESULT_CHARS = 200;

export interface ContextUsage {
  readonly system: number;
  readonly summary: number;
  readonly task: number;
  readonly permissions: number;
  readonly skills: number;
  readonly memory: number;
  readonly conversation: number;
  readonly total: number;
  readonly budget: ContextBudget;
}

export interface CompactionResult {
  readonly summary: ContextSummary;
  /** Conversation messages now folded into the summary. */
  readonly coveredMessages: number;
  /** Messages replaced by the summary in this pass. */
  readonly summarizedMessages: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export class ContextManager {
  readonly maxTokens: number;
  readonly budget: ContextBudget;

  #spec: ContextManagerOptions;
  #summarizer: Summarizer;
  #maxToolResultChars: number;
  #compactThreshold: number;
  #protectedGroups: number;
  #keepShare: number;

  #systemText?: string;
  #permissionText?: string;
  #taskText?: string;
  #skills: SkillContext[] = [];
  #memories: MemoryContext[] = [];
  #summary?: ContextSummary;

  constructor(options: number | ContextManagerOptions = {}) {
    this.#spec = typeof options === "number" ? { maxTokens: options } : { ...options };
    this.budget = resolveBudget(this.#spec);
    this.maxTokens = this.budget.maxTokens;
    this.#summarizer = this.#spec.summarizer ?? new ExtractiveSummarizer();
    this.#maxToolResultChars = this.#spec.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
    this.#compactThreshold = this.#spec.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    this.#protectedGroups = this.#spec.protectedGroups ?? 2;
    this.#keepShare = this.#spec.keepShare ?? 0.5;
  }

  // ── Context sources ─────────────────────────────────────────────
  // These live for the lifetime of the ContextManager, not the Session:
  // they are never persisted, so a resumed session rebuilds them.

  /** Core system instructions. Replaces any previously set text. */
  setSystemContext(text: string | undefined): void {
    this.#systemText = normalize(text);
  }

  /** Safety / permission constraints that must survive trimming. */
  setPermissionContext(text: string | undefined): void {
    this.#permissionText = normalize(text);
  }

  /** What the agent is currently working on. */
  setTaskContext(text: string | undefined): void {
    this.#taskText = normalize(text);
  }

  /** Replace the active Skill set. */
  setSkillContext(skills: readonly SkillContext[]): void {
    this.#skills = skills.filter((s) => s.instructions.trim() !== "");
  }

  /** Add (or replace, by name) one active Skill. */
  addSkillContext(skill: SkillContext): void {
    if (skill.instructions.trim() === "") return;
    const index = this.#skills.findIndex((s) => s.name === skill.name);
    if (index === -1) this.#skills.push(skill);
    else this.#skills[index] = skill;
  }

  clearSkills(): void {
    this.#skills = [];
  }

  /** Retrieved memories for this request, highest-ranked first. */
  setMemoryContext(memories: readonly MemoryContext[]): void {
    this.#memories = memories.filter((m) => m.content.trim() !== "");
  }

  /** Drop the per-run sources (task + memories). Skills persist for the session. */
  clearRunContext(): void {
    this.#taskText = undefined;
    this.#memories = [];
  }

  // ── Compaction state ────────────────────────────────────────────

  get summary(): ContextSummary | undefined {
    return this.#summary;
  }

  /** Restore a summary replayed from the session log. */
  restoreSummary(summary: ContextSummary | undefined): void {
    this.#summary = summary;
  }

  getTokenBudget(): ContextBudget {
    return this.budget;
  }

  /** True when the live conversation has outgrown the conversation budget. */
  needsCompaction(history: readonly ChatMessage[]): boolean {
    const live = this.#conversation(history);
    return tokensOf(live) > this.budget.conversation * this.#compactThreshold;
  }

  /**
   * Fold the older Turn Groups into a structured summary.
   *
   * The history itself is untouched — compaction only moves the window the
   * ContextManager reads from, so persistence and the TUI keep the complete
   * transcript. Returns undefined when there is nothing worth compacting.
   */
  async compact(history: readonly ChatMessage[]): Promise<CompactionResult | undefined> {
    const live = this.#conversation(history);
    const groups = splitIntoGroups(live);
    const plan = planCompaction({
      groups,
      conversationBudget: this.budget.conversation,
      protectedGroups: this.#protectedGroups,
      keepShare: this.#keepShare,
      tokens: tokensOf,
    });
    if (plan === undefined) return undefined;

    const summarized = await this.#summarizer.summarize({
      messages: plan.summarized,
      previous: this.#summary,
    });

    const coveredMessages = (this.#summary?.coveredMessages ?? 0) + plan.summarized.length;
    this.#summary = { ...summarized, coveredMessages };

    const tokensBefore = tokensOf(live);
    const tokensAfter = tokensOf(this.#conversation(history)) + tokensOf(this.#summaryMessages());

    return {
      summary: this.#summary,
      coveredMessages,
      summarizedMessages: plan.summarized.length,
      tokensBefore,
      tokensAfter,
    };
  }

  // ── Building the request ────────────────────────────────────────

  /**
   * Split the history into candidate ContextItems, each with a priority.
   * Exposed so selection is testable without running a model.
   */
  prioritize(history: readonly ChatMessage[]): ContextItem[] {
    const items: ContextItem[] = [];

    const systemMessages = history.filter((m) => m.role === "system");
    const systemText = [this.#systemText, ...systemMessages.map((m) => m.content)]
      .filter((part): part is string => part !== undefined && part.trim() !== "")
      .join("\n\n");

    if (systemText !== "") {
      items.push({
        id: "system",
        kind: "system",
        priority: CONTEXT_PRIORITY.system,
        tokens: estimateTokens(systemText),
        messages: [{ role: "system", content: systemText }],
        droppable: false,
        label: "system instructions",
      });
    }

    for (const message of this.#summaryMessages()) {
      items.push({
        id: "summary",
        kind: "summary",
        priority: CONTEXT_PRIORITY.summary,
        tokens: messageTokens(message),
        messages: [message],
        droppable: false,
        label: "compacted summary",
      });
    }

    if (this.#taskText !== undefined) {
      items.push({
        id: "task",
        kind: "task",
        priority: CONTEXT_PRIORITY.task,
        tokens: estimateTokens(`## Active task\n${this.#taskText}`),
        messages: [{ role: "system", content: `## Active task\n${this.#taskText}` }],
        droppable: false,
        label: "active task",
      });
    }

    if (this.#permissionText !== undefined) {
      items.push({
        id: "permissions",
        kind: "permissions",
        priority: CONTEXT_PRIORITY.permissions,
        tokens: estimateTokens(this.#permissionText),
        messages: [{ role: "system", content: this.#permissionText }],
        droppable: false,
        label: "permission constraints",
      });
    }

    for (const skill of this.#skills) {
      items.push({
        id: `skill:${skill.name}`,
        kind: "skill",
        priority: CONTEXT_PRIORITY.skill,
        tokens: estimateTokens(renderSkill(skill)),
        messages: [{ role: "system", content: renderSkill(skill) }],
        droppable: true,
        label: `skill:${skill.name}`,
      });
    }

    for (const memory of this.#memories) {
      const content = renderMemory(memory);
      items.push({
        id: `memory:${memory.id ?? memory.content.slice(0, 24)}`,
        kind: "memory",
        priority: CONTEXT_PRIORITY.memory,
        tokens: estimateTokens(content),
        messages: [{ role: "system", content }],
        droppable: true,
        label: "memory",
      });
    }

    const groups = splitIntoGroups(this.#conversation(history));
    groups.forEach((group, index) => {
      const age = groups.length - 1 - index;
      items.push({
        id: `conversation:${index}`,
        kind: "conversation",
        priority: conversationPriority(age, groups.length),
        tokens: tokensOf(group),
        messages: group,
        // The newest Turn Group always survives — dropping it would leave the
        // model with no idea what the user just asked.
        droppable: age !== 0,
        label: `turn group ${index}`,
      });
    });

    return items;
  }

  /** Assemble the request: everything registered, trimmed to the budget. */
  buildContext(history: readonly ChatMessage[]): ChatMessage[] {
    return this.#assemble(history, this.budget);
  }

  /**
   * Historical entry point: trim the conversation to `maxTokens`, reserving
   * nothing for output. System messages always survive, Turn Groups are
   * evicted whole, and the newest group is never dropped.
   */
  trimForRequest(history: readonly ChatMessage[]): ChatMessage[] {
    const budget = resolveBudget({ ...this.#spec, reservedOutputTokens: 0 });
    return this.#assemble(history, budget);
  }

  /** Estimated tokens of the context that would actually be sent. */
  usage(history: readonly ChatMessage[]): ContextUsage {
    const items = this.prioritize(history);
    const result = selectWithinBudget(items, {
      input: this.budget.input,
      caps: budgetCaps(this.budget),
      shrink: (item, cap) => this.#shrink(item, cap),
    });

    const sum = (kind: string): number =>
      result.kept
        .filter((item) => item.kind === kind)
        .reduce((total, item) => total + item.tokens, 0);

    return {
      system: sum("system"),
      summary: sum("summary"),
      task: sum("task"),
      permissions: sum("permissions"),
      skills: sum("skill"),
      memory: sum("memory"),
      conversation: sum("conversation"),
      total: result.used,
      budget: this.budget,
    };
  }

  // ── Internals ───────────────────────────────────────────────────

  /** Conversation messages the summary has not replaced yet. */
  #conversation(history: readonly ChatMessage[]): ChatMessage[] {
    const covered = this.#summary?.coveredMessages ?? 0;
    const conversation = history.filter((m) => m.role !== "system");
    return covered > 0 ? conversation.slice(covered) : conversation;
  }

  #summaryMessages(): ChatMessage[] {
    if (this.#summary === undefined || isEmptySummary(this.#summary)) return [];
    return [{ role: "system", content: renderSummary(this.#summary) }];
  }

  #assemble(history: readonly ChatMessage[], budget: ContextBudget): ChatMessage[] {
    const items = this.prioritize(history);
    const result = selectWithinBudget(items, {
      input: budget.input,
      caps: budgetCaps(budget),
      shrink: (item, cap) => this.#shrink(item, cap),
    });
    return result.kept.flatMap((item) => [...item.messages]);
  }

  /** Try to fit an oversized Turn Group by truncating its Tool Results. */
  #shrink(item: ContextItem, cap: number): ContextItem | undefined {
    if (item.kind !== "conversation") return undefined;

    let otherTokens = 0;
    let toolCount = 0;
    for (const message of item.messages) {
      if (message.role === "tool") toolCount++;
      else otherTokens += messageTokens(message);
    }
    if (toolCount === 0 || otherTokens > cap) return undefined;

    const perTool = Math.floor((cap - otherTokens) / toolCount);
    if (perTool < MIN_TOOL_RESULT_CHARS) return undefined;

    const messages = item.messages.map((message) =>
      message.role === "tool" && message.content.length > perTool
        ? { ...message, content: truncateMiddle(message.content, perTool) }
        : message,
    );

    const tokens = tokensOf(messages);
    if (tokens > cap) return undefined;
    return { ...item, messages, tokens };
  }
}

/** Room for the `\n…[truncated N chars]…\n` marker inside `maxChars`. */
const TRUNCATION_MARKER_RESERVE = 32;

/** Keep the head and tail of a Tool Result — the middle is usually filler. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const bodyMax = maxChars - TRUNCATION_MARKER_RESERVE;
  if (bodyMax <= 0) return text.slice(0, maxChars);
  const head = Math.floor(bodyMax * 0.6);
  const tail = bodyMax - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n…[truncated ${dropped} chars]…\n${text.slice(text.length - tail)}`;
}

export function renderSkill(skill: SkillContext): string {
  return `## Skill: ${skill.name}\n\n${skill.instructions}`;
}

export function renderMemory(memory: MemoryContext): string {
  const tag = memory.category !== undefined ? ` (${memory.category})` : "";
  return `-${tag} ${memory.content}`;
}

/** Render the memory block injected ahead of the conversation. */
export function renderMemoryBlock(memories: readonly MemoryContext[]): string {
  if (memories.length === 0) return "";
  return ["## Memory — durable project knowledge", ...memories.map(renderMemory)].join("\n");
}

function normalize(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}
