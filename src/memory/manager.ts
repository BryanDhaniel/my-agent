/**
 * MemoryManager — durable project knowledge, kept apart from the Session.
 *
 *   Agent → AgentHarness → MemoryManager → MemoryStore
 *
 * The Agent never touches persistence and never builds a memory prompt: it
 * asks the MemoryManager for what is relevant, and the Harness hands the
 * result to the ContextManager. Retrieval today is deterministic keyword and
 * metadata matching; a semantic implementation would replace the ranking
 * internals without any caller noticing.
 */

import {
  DEFAULT_IMPORTANCE,
  MAX_MEMORY_CHARS,
  MIN_MEMORY_CHARS,
  type Memory,
  type MemoryCategory,
  type MemoryQuery,
  type MemoryStore,
  type MemoryUpdate,
  type NewMemory,
  type RankedMemory,
} from "./types.js";
import { sanitizeMemoryContent, type SanitizeResult } from "./sanitize.js";
import { newMemoryId } from "./store.js";

export const DEFAULT_TOP_K = 8;
/**
 * One weak signal is not a reason to spend tokens. A whole-word hit scores 3
 * and a prefix hit scores 1, so either a single real match or two partial
 * ones clear the bar — a lone substring match does not.
 */
const DEFAULT_MIN_SCORE = 2;

export type StoreResult =
  | { readonly status: "created"; readonly memory: Memory }
  | { readonly status: "updated"; readonly memory: Memory }
  | { readonly status: "rejected"; readonly reason: string };

export interface MemoryManagerOptions {
  readonly store: MemoryStore;
  /** Swappable gate for what may be persisted. Defaults to the built-in one. */
  readonly sanitize?: (text: string) => SanitizeResult;
  /** Injected clock — keeps tests deterministic. */
  readonly now?: () => Date;
}

export interface MemoryFilter {
  readonly categories?: readonly MemoryCategory[];
}

export class MemoryManager {
  /**
   * The backing store is private on purpose: callers talk memory, not
   * persistence, so swapping in a vector store changes nothing above this line.
   */
  readonly #store: MemoryStore;
  #memories = new Map<string, Memory>();
  #sanitize: (text: string) => SanitizeResult;
  #now: () => Date;

  constructor(options: MemoryManagerOptions) {
    this.#store = options.store;
    this.#sanitize = options.sanitize ?? sanitizeMemoryContent;
    this.#now = options.now ?? (() => new Date());
  }

  /** Build a manager and hydrate it from the store in one step. */
  static async create(options: MemoryManagerOptions): Promise<MemoryManager> {
    const manager = new MemoryManager(options);
    await manager.load();
    return manager;
  }

  /** (Re)read the store. Cheap enough to call on session start. */
  async load(): Promise<void> {
    this.#memories.clear();
    for (const memory of await this.#store.load()) {
      this.#memories.set(memory.id, memory);
    }
  }

  get size(): number {
    return this.#memories.size;
  }

  async list(filter: MemoryFilter = {}): Promise<Memory[]> {
    const all = [...this.#memories.values()];
    if (filter.categories === undefined) return all;
    const allowed = new Set<string>(filter.categories);
    return all.filter((m) => allowed.has(m.category));
  }

  /**
   * Persist a memory.
   *
   * Content that repeats an existing memory (modulo case, whitespace and
   * punctuation) updates it instead of piling up a duplicate. Content that
   * looks like a secret, or that is too short or too long to be knowledge,
   * is rejected rather than stored.
   */
  async store(input: NewMemory): Promise<StoreResult> {
    const content = input.content.trim();

    if (content.length < MIN_MEMORY_CHARS) {
      return { status: "rejected", reason: "content too short to be durable knowledge" };
    }
    if (content.length > MAX_MEMORY_CHARS) {
      return { status: "rejected", reason: `content exceeds ${MAX_MEMORY_CHARS} characters` };
    }

    const sanitized = this.#sanitize(content);
    if (!sanitized.ok) return { status: "rejected", reason: sanitized.reason };

    const existing = this.#findByContent(content);
    if (existing !== undefined) {
      const merged: Memory = {
        ...existing,
        content: sanitized.content,
        category: input.category,
        importance: maxImportance(existing.importance, input.importance ?? existing.importance),
        updatedAt: this.#now().toISOString(),
        source: input.source !== existing.source ? input.source : existing.source,
      };
      await this.#store.save(merged);
      this.#memories.set(merged.id, merged);
      return { status: "updated", memory: merged };
    }

    const now = this.#now().toISOString();
    const memory: Memory = {
      id: newMemoryId(),
      content: sanitized.content,
      category: input.category,
      createdAt: now,
      updatedAt: now,
      source: input.source,
      importance: input.importance ?? DEFAULT_IMPORTANCE,
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };

    await this.#store.save(memory);
    this.#memories.set(memory.id, memory);
    return { status: "created", memory };
  }

  async update(id: string, patch: MemoryUpdate): Promise<Memory | undefined> {
    const existing = this.#memories.get(id);
    if (existing === undefined) return undefined;

    let content = existing.content;
    if (patch.content !== undefined) {
      const sanitized = this.#sanitize(patch.content.trim());
      if (!sanitized.ok) return undefined;
      content = sanitized.content;
    }

    const updated: Memory = {
      ...existing,
      content,
      category: patch.category ?? existing.category,
      importance: patch.importance ?? existing.importance,
      metadata: patch.metadata ?? existing.metadata,
      updatedAt: this.#now().toISOString(),
    };

    await this.#store.save(updated);
    this.#memories.set(id, updated);
    return updated;
  }

  /**
   * Replace a memory with a newer one that contradicts it.
   *
   * The old record is tombstoned, so contradictory knowledge never
   * accumulates silently: the new memory records what it superseded.
   */
  async supersede(
    id: string,
    input: Omit<NewMemory, "supersedes">,
  ): Promise<Memory | undefined> {
    const old = this.#memories.get(id);
    if (old === undefined) return undefined;

    const result = await this.store({ ...input, supersedes: id });
    if (result.status === "rejected") return undefined;

    await this.#store.remove(id);
    this.#memories.delete(id);
    return result.memory;
  }

  async delete(id: string): Promise<boolean> {
    if (!this.#memories.has(id)) return false;
    await this.#store.remove(id);
    this.#memories.delete(id);
    return true;
  }

  /**
   * Ranked memories for the current task, best first.
   *
   * Deterministic: score, then importance, then id. Filtering by category is
   * a hard filter; everything else is a ranking.
   */
  async retrieve(query: MemoryQuery = {}): Promise<RankedMemory[]> {
    const pool = await this.list(
      query.categories === undefined ? {} : { categories: query.categories },
    );
    const ranked = rankMemories(pool, query);
    const topK = query.topK ?? DEFAULT_TOP_K;
    return ranked.slice(0, Math.max(0, topK));
  }

  /** Discard everything queued in memory. The store is the source of truth. */
  clear(): void {
    this.#memories.clear();
  }

  #findByContent(content: string): Memory | undefined {
    const key = contentKey(content);
    for (const memory of this.#memories.values()) {
      if (contentKey(memory.content) === key) return memory;
    }
    return undefined;
  }
}

/** Normalized form used for dedupe: case, whitespace and punctuation folded. */
export function contentKey(content: string): string {
  return content.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does",
  "for", "from", "how", "i", "if", "in", "into", "is", "it", "its", "me", "my",
  "not", "of", "on", "or", "our", "please", "should", "so", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "to", "use",
  "want", "was", "we", "what", "when", "where", "which", "why", "will",
  "with", "you", "your",
]);

/** Split query text into matchable terms. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || raw.length > 40) continue;
    if (STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/**
 * Score every memory against the query.
 *
 * Whole-word hits dominate, prefix hits count for less, and importance only
 * breaks ties — so a verbose low-value memory cannot outrank a precise one.
 */
export function rankMemories(
  memories: readonly Memory[],
  query: MemoryQuery,
): RankedMemory[] {
  const terms = tokenize(query.text ?? "");
  const minScore = query.minScore ?? DEFAULT_MIN_SCORE;

  const scored = memories.map((memory) => ({ memory, score: scoreMemory(memory, terms) }));
  const relevant = terms.length === 0 ? scored : scored.filter((r) => r.score >= minScore);

  return relevant.sort(
    (a, b) =>
      b.score - a.score ||
      b.memory.importance - a.memory.importance ||
      a.memory.id.localeCompare(b.memory.id),
  );
}

function scoreMemory(memory: Memory, terms: readonly string[]): number {
  if (terms.length === 0) return memory.importance;
  const content = memory.content.toLowerCase();
  const words = content.split(/[^\p{L}\p{N}]+/u);
  let score = 0;

  for (const term of terms) {
    if (words.includes(term)) score += 3;
    else if (words.some((w) => w.startsWith(term))) score += 1;
    if (term === memory.category) score += 2;
  }

  return score;
}

function maxImportance(a: Memory["importance"], b: Memory["importance"]): Memory["importance"] {
  return b > a ? b : a;
}
