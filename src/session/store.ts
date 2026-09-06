import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "../agent/types.js";
import { isContextSummary, type ContextSummary } from "../context/summary.js";

export interface SessionMeta {
  id: string;
  provider: string;
  model: string;
  createdAt: string;
}

/**
 * A Session is a transcript plus the compaction produced while writing it.
 * Memory is deliberately not part of a Session: it outlives it.
 */
export interface LoadedSession {
  meta: SessionMeta;
  messages: ChatMessage[];
  summary?: ContextSummary;
}

type SessionLine =
  | { type: "meta"; meta: SessionMeta }
  | { type: "message"; message: ChatMessage }
  | { type: "summary"; summary: ContextSummary };

export class SessionStore {
  readonly dir: string;

  constructor(dir: string = path.join(os.homedir(), ".my-agent", "sessions")) {
    this.dir = dir;
  }

  #file(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  static newId(now = new Date()): string {
    const date = now.toISOString().slice(0, 10);
    return `${date}-${randomUUID().slice(0, 8)}`;
  }

  async create(meta: SessionMeta): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const line: SessionLine = { type: "meta", meta };
    await writeFile(this.#file(meta.id), JSON.stringify(line) + "\n", "utf8");
  }

  async append(id: string, message: ChatMessage): Promise<void> {
    const line: SessionLine = { type: "message", message };
    await writeFile(this.#file(id), JSON.stringify(line) + "\n", { flag: "a", encoding: "utf8" });
  }

  /** Append a compaction. The newest one wins on load. */
  async appendSummary(id: string, summary: ContextSummary): Promise<void> {
    const line: SessionLine = { type: "summary", summary };
    await writeFile(this.#file(id), JSON.stringify(line) + "\n", { flag: "a", encoding: "utf8" });
  }

  async load(id: string): Promise<LoadedSession | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#file(id), "utf8");
    } catch {
      return undefined;
    }
    return parseSession(raw);
  }

  /** All sessions, newest first. */
  async list(): Promise<LoadedSession[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const sessions: LoadedSession[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const session = await this.load(file.slice(0, -".jsonl".length));
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) => (a.meta.createdAt < b.meta.createdAt ? 1 : -1));
  }

  /** Most recent session by createdAt, or undefined when none exist. */
  async latest(): Promise<LoadedSession | undefined> {
    return (await this.list())[0];
  }

  async delete(id: string): Promise<void> {
    await rm(this.#file(id), { force: true });
  }
}

export function parseSession(raw: string): LoadedSession | undefined {
  const messages: ChatMessage[] = [];
  let meta: SessionMeta | undefined;
  let summary: ContextSummary | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    let parsed: SessionLine;
    try {
      parsed = JSON.parse(line) as SessionLine;
    } catch {
      continue; // A corrupt line must not make a whole session unreadable.
    }

    switch (parsed.type) {
      case "meta":
        meta = parsed.meta;
        break;
      case "message":
        messages.push(parsed.message);
        break;
      case "summary":
        if (isContextSummary(parsed.summary)) summary = parsed.summary;
        break;
    }
  }

  return meta ? { meta, messages, ...(summary !== undefined ? { summary } : {}) } : undefined;
}
