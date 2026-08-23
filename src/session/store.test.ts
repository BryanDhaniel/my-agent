import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { SessionStore } from "./store.js";

async function makeStore(): Promise<{ store: SessionStore; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "my-agent-sessions-"));
  return { store: new SessionStore(dir), dir };
}

function meta(id: string, createdAtOffsetMs = 0) {
  return {
    id,
    provider: "openai",
    model: "gpt-test",
    createdAt: new Date(Date.now() + createdAtOffsetMs).toISOString(),
  };
}

describe("SessionStore", () => {
  it("round-trips meta and messages through JSONL", async () => {
    const { store } = await makeStore();
    const m = meta("rt");
    await store.create(m);
    await store.append(m.id, { role: "user", content: "hello" });
    await store.append(m.id, { role: "assistant", content: "hi" });

    const loaded = await store.load(m.id);
    assert.ok(loaded);
    assert.equal(loaded.meta.id, m.id);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[0]?.role, "user");
    assert.equal(loaded.messages[1]?.role, "assistant");
  });

  it("latest() returns the newest session by createdAt", async () => {
    const { store } = await makeStore();
    await store.create(meta("older", -1000));
    await store.create(meta("newer", 0));
    const latest = await store.latest();
    assert.ok(latest);
    assert.equal(latest.meta.id, "newer");
  });

  it("load() returns undefined for missing sessions", async () => {
    const { store } = await makeStore();
    assert.equal(await store.load("nope"), undefined);
  });

  it("lists sessions newest first with their messages", async () => {
    const { store } = await makeStore();
    await store.create(meta("old", -10_000));
    await store.append("old", { role: "user", content: "hi" });
    await store.create(meta("new", 0));
    await store.append("new", { role: "user", content: "yo" });
    await store.append("new", { role: "assistant", content: "hey" });

    const sessions = await store.list();
    assert.deepEqual(
      sessions.map((s) => s.meta.id),
      ["new", "old"],
    );
    assert.equal(sessions[0]?.messages.length, 2);
    assert.equal(sessions[1]?.messages.length, 1);
  });

  it("delete() removes the file and it disappears from list/load", async () => {
    const { store } = await makeStore();
    await store.create(meta("gone"));
    await store.delete("gone");

    assert.equal(await store.load("gone"), undefined);
    assert.deepEqual(await store.list(), []);
    // deleting a missing session is a no-op
    await store.delete("never-existed");
  });
});
