/**
 * The structured shape of a compacted conversation.
 *
 * Compaction must not be "delete the oldest messages": it replaces them with a
 * recoverable record of what mattered. ContextSummary is that record — plain
 * JSON, so it round-trips through the session log and stays diffable.
 */

export const SUMMARY_VERSION = 1 as const;

/** Cap per list so a long session cannot grow a summary without bound. */
const MAX_LIST_ITEMS = 12;

export interface ContextSummary {
  readonly version: typeof SUMMARY_VERSION;
  /** What the agent is currently trying to do. */
  readonly task: string;
  /** Choices that were made and should not be re-litigated. */
  readonly decisions: readonly string[];
  /** Stable facts worth keeping beyond this session. */
  readonly importantFacts: readonly string[];
  /** Tool Calls that already ran. */
  readonly completedActions: readonly string[];
  /** Work that was started but not finished. */
  readonly pendingActions: readonly string[];
  /** Errors and surprises encountered on the way. */
  readonly discoveredIssues: readonly string[];
  /** Paths the session touched. */
  readonly relevantFiles: readonly string[];
  /**
   * How many leading conversation messages (system messages excluded) this
   * summary replaces. Counting conversation messages rather than array
   * indices keeps the offset valid even when system messages are interleaved.
   */
  readonly coveredMessages: number;
  readonly createdAt: string;
}

export interface SummaryDraft {
  task?: string;
  decisions?: readonly string[];
  importantFacts?: readonly string[];
  completedActions?: readonly string[];
  pendingActions?: readonly string[];
  discoveredIssues?: readonly string[];
  relevantFiles?: readonly string[];
  coveredMessages?: number;
  createdAt?: string;
}

export function emptySummary(now = new Date()): ContextSummary {
  return {
    version: SUMMARY_VERSION,
    task: "",
    decisions: [],
    importantFacts: [],
    completedActions: [],
    pendingActions: [],
    discoveredIssues: [],
    relevantFiles: [],
    coveredMessages: 0,
    createdAt: now.toISOString(),
  };
}

export function makeSummary(draft: SummaryDraft, now = new Date()): ContextSummary {
  return {
    ...emptySummary(now),
    ...draft,
    coveredMessages: Math.max(0, Math.floor(draft.coveredMessages ?? 0)),
    createdAt: draft.createdAt ?? now.toISOString(),
  };
}

/** Structural check — used when replaying a session log written by an older build. */
export function isContextSummary(value: unknown): value is ContextSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["task"] === "string" &&
    Array.isArray(v["decisions"]) &&
    Array.isArray(v["importantFacts"]) &&
    Array.isArray(v["completedActions"]) &&
    Array.isArray(v["pendingActions"]) &&
    Array.isArray(v["discoveredIssues"]) &&
    Array.isArray(v["relevantFiles"]) &&
    typeof v["coveredMessages"] === "number"
  );
}

/**
 * Fold a newer summary over an older one.
 *
 * The newer summary describes the recent slice, so it wins for `task` and
 * `coveredMessages`; the lists are unioned (newest first, deduped, capped) so
 * a fact discovered twenty Turns ago survives a second compaction.
 */
export function mergeSummaries(
  previous: ContextSummary | undefined,
  next: ContextSummary,
): ContextSummary {
  if (previous === undefined) return next;
  return {
    version: SUMMARY_VERSION,
    task: next.task !== "" ? next.task : previous.task,
    decisions: union(next.decisions, previous.decisions),
    importantFacts: union(next.importantFacts, previous.importantFacts),
    completedActions: union(next.completedActions, previous.completedActions),
    pendingActions: union(next.pendingActions, previous.pendingActions),
    discoveredIssues: union(next.discoveredIssues, previous.discoveredIssues),
    relevantFiles: union(next.relevantFiles, previous.relevantFiles),
    coveredMessages: Math.max(next.coveredMessages, previous.coveredMessages),
    createdAt: next.createdAt,
  };
}

/** Render as the system-level text the model actually sees. */
export function renderSummary(summary: ContextSummary): string {
  const lines: string[] = ["## Earlier in this session (compacted)"];
  if (summary.task !== "") lines.push(`Task: ${summary.task}`);

  const sections: Array<[string, readonly string[]]> = [
    ["Decisions", summary.decisions],
    ["Facts", summary.importantFacts],
    ["Completed", summary.completedActions],
    ["Pending", summary.pendingActions],
    ["Issues", summary.discoveredIssues],
    ["Files", summary.relevantFiles],
  ];

  for (const [label, values] of sections) {
    if (values.length === 0) continue;
    lines.push(`${label}:`);
    for (const value of values) lines.push(`- ${value}`);
  }

  return lines.join("\n");
}

/** True when the summary carries nothing worth injecting. */
export function isEmptySummary(summary: ContextSummary): boolean {
  return (
    summary.task === "" &&
    summary.decisions.length === 0 &&
    summary.importantFacts.length === 0 &&
    summary.completedActions.length === 0 &&
    summary.pendingActions.length === 0 &&
    summary.discoveredIssues.length === 0 &&
    summary.relevantFiles.length === 0
  );
}

/**
 * Pull file-looking tokens out of free text. Deliberately loose: a summary
 * with one extra path is cheaper than one missing the file under discussion.
 */
export function extractFilePaths(text: string): string[] {
  // URLs are not project paths — drop them before matching.
  const withoutUrls = text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
  const matches = withoutUrls.match(/[\w.@-]+(?:\/[\w.@-]+)+/g) ?? [];
  const out: string[] = [];
  for (const match of matches) {
    if (!/\.[A-Za-z0-9]{1,6}$/.test(match)) continue;
    if (!out.includes(match)) out.push(match);
  }
  return out;
}

function union(next: readonly string[], previous: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of [...next, ...previous]) {
    const trimmed = value.trim();
    if (trimmed === "" || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}
