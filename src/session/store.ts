import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "../agent/types.js";

export interface SessionMeta {
  id: string;
  provider: string;
  model: string;
  createdAt: string;
}

export interface LoadedSession {
  meta: SessionMeta;
  messages: ChatMessage[];
}

type SessionLine = { type: "meta"; meta: SessionMeta } | { type: "message"; message: ChatMessage };

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

  async load(id: string): Promise<LoadedSession | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#file(id), "utf8");
    } catch {
      return undefined;
    }
    return parseSession(raw);
  }

  /** Most recent session by createdAt, or undefined when none exist. */
  async latest(): Promise<LoadedSession | undefined> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return undefined;
    }
    let best: LoadedSession | undefined;
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.slice(0, -".jsonl".length);
      const session = await this.load(id);
      if (session && (!best || session.meta.createdAt > best.meta.createdAt)) {
        best = session;
      }
    }
    return best;
  }
}

export function parseSession(raw: string): LoadedSession | undefined {
  const messages: ChatMessage[] = [];
  let meta: SessionMeta | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as SessionLine;
    if (parsed.type === "meta") meta = parsed.meta;
    else messages.push(parsed.message);
  }

  return meta ? { meta, messages } : undefined;
}
