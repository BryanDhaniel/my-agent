import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AgentEvent } from "../harness/events.js";
import {
  appendNotice,
  initialViewState,
  reduceChatEvent,
  replaceEntries,
  setError,
  setBusy,
  type ChatViewState,
} from "./view.js";

function run(state: ChatViewState, ...events: AgentEvent[]): ChatViewState {
  return events.reduce(reduceChatEvent, state);
}

describe("ChatViewState reducer", () => {
  it("starts empty and idle", () => {
    const state = initialViewState();
    assert.equal(state.entries.length, 0);
    assert.equal(state.liveText, "");
    assert.equal(state.busy, false);
    assert.equal(state.error, undefined);
  });

  it("accumulates text deltas into liveText", () => {
    const state = run(
      initialViewState(),
      { type: "text-delta", delta: "he" },
      { type: "text-delta", delta: "llo" },
    );
    assert.equal(state.liveText, "hello");
    assert.equal(state.entries.length, 0); // nothing final yet
  });

  it("assistant-message flushes liveText and appends the entry", () => {
    const state = run(
      initialViewState(),
      { type: "text-delta", delta: "hi" },
      { type: "assistant-message", message: { role: "assistant", content: "hi there" } },
    );
    assert.equal(state.liveText, "");
    const last = state.entries.at(-1);
    assert.ok(last?.kind === "message" && last.content === "hi there");
  });

  it("hides tool-only assistant turns with empty content", () => {
    const state = reduceChatEvent(initialViewState(), {
      type: "assistant-message",
      message: { role: "assistant", content: "", toolCalls: [{ id: "t", name: "read_file", arguments: "{}" }] },
    });
    assert.deepEqual(state.entries, []);
  });

  it("shows assistant turns that mix text and tool calls", () => {
    const state = reduceChatEvent(initialViewState(), {
      type: "assistant-message",
      message: { role: "assistant", content: "let me check", toolCalls: [{ id: "t", name: "read_file", arguments: "{}" }] },
    });
    assert.equal(state.entries.length, 1);
  });

  it("tracks a Tool Call through start -> result, keeping full output", () => {
    let state = reduceChatEvent(initialViewState(), {
      type: "tool-start",
      callId: "c1",
      toolName: "read_file",
      argsJson: '{"path":"notes.txt"}',
    });
    const started = state.entries.at(-1);
    assert.ok(started?.kind === "tool" && started.status === "running");
    assert.equal(started.detail, "notes.txt");

    state = reduceChatEvent(state, {
      type: "tool-result",
      callId: "c1",
      toolName: "read_file",
      output: "hello\nworld",
    });
    const done = state.entries.at(-1);
    assert.ok(done?.kind === "tool");
    if (done?.kind === "tool") {
      assert.equal(done.status, "done");
      assert.match(done.detail, /hello/);
      assert.equal(done.output, "hello\nworld");
    }
  });

  it("marks denied calls without losing earlier detail", () => {
    let state = reduceChatEvent(initialViewState(), {
      type: "tool-start",
      callId: "c2",
      toolName: "write_file",
      argsJson: '{"path":"x.txt","content":"abc"}',
    });
    state = reduceChatEvent(state, {
      type: "tool-denied",
      callId: "c2",
      toolName: "write_file",
      reason: "the user declined",
    });
    const denied = state.entries.at(-1);
    assert.ok(denied?.kind === "tool" && denied.status === "denied");
    assert.match(denied.detail, /x\.txt/);
    assert.match(denied.detail, /declined/);
  });

  it("reports invalid JSON arguments as detail instead of throwing", () => {
    const state = reduceChatEvent(initialViewState(), {
      type: "tool-start",
      callId: "c3",
      toolName: "run_bash",
      argsJson: "{broken",
    });
    const entry = state.entries.at(-1);
    assert.ok(entry?.kind === "tool");
    assert.equal(entry.status, "running"); // still renders; loop handles the error path
  });

  it("captures error messages", () => {
    const state = reduceChatEvent(initialViewState(), {
      type: "error",
      error: new Error("boom"),
    });
    assert.equal(state.error, "boom");
  });

  it("appendNotice / replaceEntries / setBusy / setError behave purely", () => {
    const base = initialViewState();
    const noticed = appendNotice(base, "hint");
    assert.equal(noticed.entries[0]?.kind, "notice");
    assert.equal(base.entries.length, 0); // original untouched

    const replaced = replaceEntries(noticed, [
      { kind: "message", role: "user", content: "replayed" },
    ]);
    assert.equal(replaced.entries.length, 1);

    assert.equal(setBusy(base, true).busy, true);
    assert.equal(setError(base, "x")?.error, "x");
  });
});
