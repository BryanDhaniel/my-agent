/**
 * The Memory vocabulary.
 *
 * Memory is durable knowledge about the project — not a copy of the
 * conversation. It outlives the Session that produced it, and it is the only
 * part of the agent's state that is meant to be read by future Sessions.
 */

import type { ContextSummary } from "../context/summary.js";

/**
 * A deliberately small taxonomy: each category earns its place by changing
 * how a memory is retrieved or how long it should be trusted.
 */
export const MEMORY_CATEGORIES = [
  "project",
  "preference",
  "decision",
  "fact",
  "debugging",
  "architecture",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

/** 1 = nice to know, 5 = load-bearing. Drives ranking ties. */
export type Importance = 1 | 2 | 3 | 4 | 5;

export const DEFAULT_IMPORTANCE: Importance = 3;

export interface Memory {
  readonly id: string;
  readonly content: string;
  readonly category: MemoryCategory;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Where the memory came from: a session id, "user", or a tool name. */
  readonly source: string;
  readonly importance: Importance;
  /** Set when this memory replaces an earlier one. */
  readonly supersedes?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface NewMemory {
  readonly content: string;
  readonly category: MemoryCategory;
  readonly source: string;
  readonly importance?: Importance;
  readonly supersedes?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface MemoryUpdate {
  readonly content?: string;
  readonly category?: MemoryCategory;
  readonly importance?: Importance;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface MemoryQuery {
  /** Free text to match against — typically the user's current request. */
  readonly text?: string;
  /** Hard filter; omitted means every category. */
  readonly categories?: readonly MemoryCategory[];
  /** How many memories to return. */
  readonly topK?: number;
  /** Memories scoring below this are not worth the tokens. */
  readonly minScore?: number;
}

export interface RankedMemory {
  readonly memory: Memory;
  readonly score: number;
}

/**
 * The persistence seam.
 *
 * The Agent and the Harness only ever see `MemoryManager`; swapping the local
 * JSONL store for a vector store later means implementing this interface and
 * nothing else.
 */
export interface MemoryStore {
  /** Every live memory, oldest first. */
  load(): Promise<Memory[]>;
  /** Persist a memory — create it, or replace the record with the same id. */
  save(memory: Memory): Promise<void>;
  /** Remove a memory permanently. */
  remove(id: string): Promise<void>;
}

/**
 * What a Session carries. Kept here so the boundary stays visible:
 * a Session is a transcript plus a compaction summary — never memory.
 */
export interface SessionContext {
  readonly sessionId: string;
  readonly summary?: ContextSummary;
}

/** Longest memory we will persist — memory is knowledge, not documents. */
export const MAX_MEMORY_CHARS = 600;
/** Below this a "memory" is noise. */
export const MIN_MEMORY_CHARS = 12;
