import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it } from "vitest";
import { LocalMemoryStore, parseMemoryLog, replay, serialize } from "./store.js";
import { MemoryManager, contentKey, rankMemories, tokenize } from "./manager.js";
import type { Memory, MemoryCategory } from "./types.js";

let dir: string;
let store: LocalMemoryStore;
let memories: MemoryManager;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "my-agent-memory-"));
  store = new LocalMemoryStore(path.join(dir, ".memory", "memories.jsonl"));
  memories = await MemoryManager.create({ store });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function memory(
  id: string,
  content: string,
  category: MemoryCategory = "project",
  importance: Memory["importance"] = 3,
): Memory {
  return {
    id,
    content,
    category,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "session:test",
    importance,
  };
}

describe("LocalMemoryStore", () => {
  it("returns nothing when the store has never been written", async () => {
    assert.deepEqual(await store.load(), []);
  });

  it("round-trips memories through the log", async () => {
    const one = memory("a", "uses vitest");
    const two = memory("b", "prefers tabs", "preference");
    await store.save(one);
    await store.save(two);

    assert.deepEqual(await store.load(), [one, two]);
  });

  it("survives a fresh manager reading the same file", async () => {
    await store.save(memory("a", "the harness owns the lifecycle", "architecture"));
    const reloaded = await MemoryManager.create({ store });
    assert.equal(reloaded.size, 1);
    assert.match((await reloaded.list())[0]?.content ?? "", /harness owns the lifecycle/);
  });

  it("treats a later record with the same id as an update", async () => {
    await store.save(memory("a", "old content"));
    await store.save({ ...memory("a", "new content"), updatedAt: "2026-02-01T00:00:00.000Z" });

    const loaded = await store.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.content, "new content");
    assert.equal(loaded[0]?.updatedAt, "2026-02-01T00:00:00.000Z");
  });

  it("removes a memory with a tombstone", async () => {
    await store.save(memory("a", "gone soon"));
    await store.remove("a");
    assert.deepEqual(await store.load(), []);
  });

  it("ignores corrupt lines instead of losing the store", async () => {
    await mkdir(path.dirname(store.file), { recursive: true });
    await writeFile(
      store.file,
      `${JSON.stringify({ type: "memory", memory: memory("a", "keep me") })}\n` +
        `not json at all\n` +
        `\n` +
        `${JSON.stringify({ type: "nonsense" })}\n` +
        `${JSON.stringify({ type: "memory", memory: memory("b", "also keep") })}\n`,
      "utf8",
    );
    const loaded = await store.load();
    assert.deepEqual(loaded.map((m) => m.id), ["a", "b"]);
  });

  it("skips records that fail validation", async () => {
    await mkdir(path.dirname(store.file), { recursive: true });
    await writeFile(
      store.file,
      `${JSON.stringify({ type: "memory", memory: { id: "x" } })}\n` +
        `${JSON.stringify({ type: "memory", memory: { id: "y", content: "c", category: "bogus" } })}\n` +
        `${JSON.stringify({ type: "memory", memory: memory("z", "valid") })}\n`,
      "utf8",
    );
    assert.deepEqual((await store.load()).map((m) => m.id), ["z"]);
  });

  it("compact() drops superseded records but keeps the live set", async () => {
    await store.save(memory("a", "first"));
    await store.save(memory("b", "second"));
    await store.remove("a");
    await store.save(memory("c", "third"));

    assert.equal(await store.compact(), 2);
    assert.deepEqual((await store.load()).map((m) => m.id), ["b", "c"]);

    const raw = await readFile(store.file, "utf8");
    assert.equal(raw.trim().split("\n").length, 2);
  });

  it("defaultPath() puts the log under .memory/ in the project", () => {
    assert.equal(LocalMemoryStore.defaultPath("/repo"), path.join("/repo", ".memory", "memories.jsonl"));
  });
});

describe("replay", () => {
  it("applies tombstones regardless of position", () => {
    const records = parseMemoryLog(
      serialize([
        { type: "memory", memory: memory("a", "one") },
        { type: "tombstone", id: "b", at: "now" },
        { type: "memory", memory: memory("b", "two") },
        { type: "memory", memory: memory("c", "three") },
      ]),
    );
    assert.deepEqual(replay(records).map((m) => m.id), ["a", "c"]);
  });
});

describe("MemoryManager store", () => {
  it("creates a memory with generated metadata", async () => {
    const result = await memories.store({
      content: "The context layer is budgeted, not trimmed after the fact.",
      category: "architecture",
      source: "session:abc",
      importance: 4,
    });

    assert.equal(result.status, "created");
    if (result.status === "created") {
      assert.ok(result.memory.id.length > 0);
      assert.equal(result.memory.category, "architecture");
      assert.equal(result.memory.importance, 4);
      assert.equal(result.memory.source, "session:abc");
      assert.ok(result.memory.createdAt === result.memory.updatedAt);
    }
  });

  it("updates instead of duplicating when the same fact arrives again", async () => {
    await memories.store({ content: "We use pnpm for installs.", category: "project", source: "s1" });
    const second = await memories.store({
      content: "we use pnpm for installs",
      category: "project",
      source: "s2",
      importance: 5,
    });

    assert.equal(second.status, "updated");
    assert.equal(memories.size, 1);
    if (second.status === "updated") {
      assert.equal(second.memory.importance, 5, "importance is raised, never lowered");
    }
  });

  it("rejects content that is too short to be knowledge", async () => {
    const result = await memories.store({ content: "ok", category: "fact", source: "s1" });
    assert.equal(result.status, "rejected");
    assert.equal(memories.size, 0);
  });

  it("rejects content that is too long to be knowledge", async () => {
    const result = await memories.store({
      content: "x".repeat(601),
      category: "fact",
      source: "s1",
    });
    assert.equal(result.status, "rejected");
    assert.equal(memories.size, 0);
  });

  it("rejects secrets instead of persisting them", async () => {
    const result = await memories.store({
      content: "the deploy token is ghp_" + "abcdefghijklmnopqrstuvwxyz1234",
      category: "fact",
      source: "s1",
    });
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.match(result.reason, /secret/);
    assert.equal(memories.size, 0);
    assert.deepEqual(await store.load(), []);
  });

  it("persists through the store so a restart sees it", async () => {
    await memories.store({ content: "Sessions are append-only JSONL.", category: "project", source: "s1" });
    const reloaded = await MemoryManager.create({ store });
    assert.equal(reloaded.size, 1);
  });

  it("update() patches content and bumps updatedAt", async () => {
    const created = await memories.store({ content: "We use npm here.", category: "project", source: "s1" });
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const updated = await memories.update(created.memory.id, {
      content: "We use pnpm here.",
      importance: 5,
    });

    assert.equal(updated?.content, "We use pnpm here.");
    assert.equal(updated?.importance, 5);
    assert.equal(updated?.id, created.memory.id, "the id is stable across updates");
    assert.ok(updated!.updatedAt >= created.memory.updatedAt);
    assert.equal(memories.size, 1);
  });

  it("update() refuses to write a secret and returns undefined", async () => {
    const created = await memories.store({ content: "Build with vite.", category: "project", source: "s1" });
    if (created.status !== "created") throw new Error("setup failed");

    const result = await memories.update(created.memory.id, {
      content: "password = hunter2hunter2",
    });
    assert.equal(result, undefined);
    assert.equal((await memories.list())[0]?.content, "Build with vite.");
  });

  it("update() returns undefined for an unknown id", async () => {
    assert.equal(await memories.update("nope", { content: "anything at all here" }), undefined);
  });

  it("supersede() replaces a contradicted memory and records the link", async () => {
    const created = await memories.store({ content: "We use npm for installs.", category: "project", source: "s1" });
    if (created.status !== "created") throw new Error("setup failed");

    const next = await memories.supersede(created.memory.id, {
      content: "We use pnpm for installs.",
      category: "project",
      source: "s1",
    });

    assert.ok(next);
    assert.equal(next?.supersedes, created.memory.id);

    const live = await memories.list();
    assert.equal(live.length, 1, "the contradicted memory is gone, not accumulated");
    assert.equal(live[0]?.id, next?.id);
    assert.deepEqual(await store.load(), live);
  });

  it("supersede() returns undefined for an unknown id", async () => {
    assert.equal(
      await memories.supersede("nope", { content: "nothing to replace", category: "fact", source: "s" }),
      undefined,
    );
  });

  it("delete() removes a memory and reports whether it existed", async () => {
    const created = await memories.store({ content: "Temporary experiment.", category: "fact", source: "s1" });
    if (created.status !== "created") throw new Error("setup failed");

    assert.equal(await memories.delete(created.memory.id), true);
    assert.equal(await memories.delete(created.memory.id), false);
    assert.equal(memories.size, 0);
    assert.deepEqual(await store.load(), []);
  });

  it("list() filters by category", async () => {
    await memories.store({ content: "Sessions are JSONL files.", category: "project", source: "s1" });
    await memories.store({ content: "Always run typecheck.", category: "preference", source: "s1" });

    assert.equal((await memories.list()).length, 2);
    assert.equal((await memories.list({ categories: ["preference"] })).length, 1);
    assert.equal((await memories.list({ categories: ["debugging"] })).length, 0);
  });
});

describe("MemoryManager retrieve", () => {
  beforeEach(async () => {
    await memories.store({
      content: "The project uses vitest for tests and typecheck before commits.",
      category: "project",
      source: "s1",
      importance: 4,
    });
    await memories.store({
      content: "Sessions persist as append-only JSONL under ~/.my-agent/sessions.",
      category: "architecture",
      source: "s1",
      importance: 3,
    });
    await memories.store({
      content: "A flaky test was caused by a shared temp directory.",
      category: "debugging",
      source: "s1",
      importance: 2,
    });
  });

  it("ranks the memory matching the task highest", async () => {
    const ranked = await memories.retrieve({ text: "how do I run the tests?" });
    assert.ok(ranked.length >= 1);
    assert.match(ranked[0]?.memory.content ?? "", /vitest/);
    assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
  });

  it("returns different memories for a different task", async () => {
    const ranked = await memories.retrieve({ text: "where are sessions stored?" });
    assert.match(ranked[0]?.memory.content ?? "", /append-only JSONL/);
  });

  it("honours topK", async () => {
    const ranked = await memories.retrieve({ text: "tests sessions jsonl", topK: 2 });
    assert.equal(ranked.length, 2);
  });

  it("filters by category before ranking", async () => {
    const ranked = await memories.retrieve({ text: "tests", categories: ["debugging"] });
    assert.ok(ranked.length <= 1);
    assert.ok(ranked.every((r) => r.memory.category === "debugging"));
  });

  it("returns nothing when no memory is relevant", async () => {
    assert.deepEqual(await memories.retrieve({ text: "kubernetes helm charts" }), []);
  });

  it("returns everything by importance when there is no query text", async () => {
    const ranked = await memories.retrieve({});
    assert.equal(ranked.length, 3);
    assert.deepEqual(ranked.map((r) => r.memory.importance), [4, 3, 2]);
  });

  it("is deterministic for equal scores", async () => {
    const a = await memories.retrieve({ text: "the project" });
    const b = await memories.retrieve({ text: "the project" });
    assert.deepEqual(a, b);
  });

  it("never returns a deleted memory", async () => {
    const all = await memories.list();
    await memories.delete(all[0]!.id);
    const ranked = await memories.retrieve({});
    assert.equal(ranked.length, 2);
    assert.ok(!ranked.some((r) => r.memory.id === all[0]!.id));
  });
});

describe("ranking helpers", () => {
  it("tokenize drops stopwords, digits and duplicates", () => {
    assert.deepEqual(tokenize("How do I run the 42 tests? tests"), ["run", "tests"]);
  });

  it("contentKey folds case, punctuation and whitespace", () => {
    assert.equal(contentKey("We use PNPM!"), contentKey("  we   use pnpm  "));
  });

  it("rankMemories breaks ties on importance then id", () => {
    const low = memory("b", "deploy on fridays", "fact", 2);
    const high = memory("a", "deploy on fridays", "fact", 5);
    const ranked = rankMemories([low, high], { text: "deploy" });
    assert.deepEqual(ranked.map((r) => r.memory.id), ["a", "b"]);
  });
});
