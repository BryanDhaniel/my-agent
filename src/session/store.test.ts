import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { SessionStore } from "./store.js";

describe("SessionStore", () => {
  it("round-trips meta and messages through JSONL", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "my-agent-test-"));
    const store = new SessionStore(dir);

    const meta = {
      id: SessionStore.newId(),
      provider: "openai",
      model: "gpt-test",
      createdAt: new Date().toISOString(),
    };
    await store.create(meta);
    await store.append(meta.id, { role: "user", content: "hello" });
    await store.append(meta.id, { role: "assistant", content: "hi" });

    const loaded = await store.load(meta.id);
    assert.ok(loaded);
    assert.equal(loaded.meta.id, meta.id);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[0]?.role, "user");
    assert.equal(loaded.messages[1]?.role, "assistant");
  });

  it("latest() returns the newest session by createdAt", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "my-agent-test-"));
    const store = new SessionStore(dir);

    for (const [id, offset] of [
      ["older", 0],
      ["newer", 1000],
    ] as const) {
      const meta = {
        id,
        provider: "openai",
        model: "gpt-test",
        createdAt: new Date(Date.now() + offset).toISOString(),
      };
      await store.create(meta);
      await store.append(id, { role: "user", content: id });
    }

    const latest = await store.latest();
    assert.ok(latest);
    assert.equal(latest.meta.id, "newer");
  });

  it("load() returns undefined for missing sessions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "my-agent-test-"));
    const store = new SessionStore(dir);
    assert.equal(await store.load("nope"), undefined);
  });
});
