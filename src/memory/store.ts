/**
 * LocalMemoryStore — append-only JSONL under `.memory/`.
 *
 * The log is the source of truth. Writes only ever append, so an interrupted
 * run can never leave a half-written memory; `load()` replays the log:
 *
 *   - `{type:"memory"}` records are last-write-wins by id (an update is just a
 *     newer record with the same id)
 *   - `{type:"tombstone"}` records delete an id
 *
 * `compact()` rewrites the log with only the live records. It is the one place
 * that rewrites history, and it is safe to run at any time.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMemoryCategory, type Memory, type MemoryStore } from "./types.js";

export type MemoryRecord =
  | { readonly type: "memory"; readonly memory: Memory }
  | { readonly type: "tombstone"; readonly id: string; readonly at: string };

export const MEMORY_FILE_NAME = "memories.jsonl";
export const MEMORY_DIR_NAME = ".memory";

export class LocalMemoryStore implements MemoryStore {
  readonly file: string;

  constructor(file: string = LocalMemoryStore.defaultPath()) {
    this.file = file;
  }

  static defaultPath(cwd: string = process.cwd()): string {
    return path.join(cwd, MEMORY_DIR_NAME, MEMORY_FILE_NAME);
  }

  async load(): Promise<Memory[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    return replay(parseMemoryLog(raw));
  }

  async save(memory: Memory): Promise<void> {
    await this.#append({ type: "memory", memory });
  }

  async remove(id: string): Promise<void> {
    await this.#append({ type: "tombstone", id, at: new Date().toISOString() });
  }

  /** Rewrite the log with only the live records. */
  async compact(): Promise<number> {
    const live = await this.load();
    const records: MemoryRecord[] = live.map((memory) => ({ type: "memory", memory }));
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, serialize(records), "utf8");
    await rename(tmp, this.file);
    return records.length;
  }

  async #append(record: MemoryRecord): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(record)}\n`, { flag: "a", encoding: "utf8" });
  }
}

export function newMemoryId(): string {
  return randomUUID().slice(0, 8);
}

/** Parse a memory log, skipping blank and malformed lines. */
export function parseMemoryLog(raw: string): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // A corrupt line must not take the whole store down.
    }
    const record = asRecord(parsed);
    if (record !== undefined) records.push(record);
  }
  return records;
}

export function serialize(records: readonly MemoryRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

/** Fold records into the live memory set, oldest first. */
export function replay(records: readonly MemoryRecord[]): Memory[] {
  const byId = new Map<string, Memory>();
  const order: string[] = [];
  const deleted = new Set<string>();

  for (const record of records) {
    if (record.type === "tombstone") {
      deleted.add(record.id);
      byId.delete(record.id);
      continue;
    }
    if (deleted.has(record.memory.id)) continue;
    if (!byId.has(record.memory.id)) order.push(record.memory.id);
    byId.set(record.memory.id, record.memory);
  }

  return order.map((id) => byId.get(id)).filter((m): m is Memory => m !== undefined);
}

function asRecord(value: unknown): MemoryRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record["type"] === "tombstone" && typeof record["id"] === "string") {
    return { type: "tombstone", id: record["id"], at: String(record["at"] ?? "") };
  }
  if (record["type"] === "memory") {
    const memory = asMemory(record["memory"]);
    return memory === undefined ? undefined : { type: "memory", memory };
  }
  return undefined;
}

function asMemory(value: unknown): Memory | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const m = value as Record<string, unknown>;
  if (typeof m["id"] !== "string" || typeof m["content"] !== "string") return undefined;
  if (!isMemoryCategory(m["category"])) return undefined;
  const importance = m["importance"];
  return {
    id: m["id"],
    content: m["content"],
    category: m["category"],
    createdAt: String(m["createdAt"] ?? ""),
    updatedAt: String(m["updatedAt"] ?? ""),
    source: String(m["source"] ?? "unknown"),
    importance: isImportance(importance) ? importance : 3,
    ...(typeof m["supersedes"] === "string" ? { supersedes: m["supersedes"] } : {}),
    ...(isMetadata(m["metadata"]) ? { metadata: m["metadata"] } : {}),
  };
}

function isImportance(value: unknown): value is Memory["importance"] {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

function isMetadata(
  value: unknown,
): value is Record<string, string | number | boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
}
