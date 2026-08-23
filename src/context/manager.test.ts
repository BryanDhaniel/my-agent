import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ContextManager, estimateTokens } from "./manager.js";
import type { ChatMessage } from "../agent/types.js";

const system: ChatMessage = { role: "system", content: "sys" };

function bigUser(text: string): ChatMessage {
  return { role: "user", content: text };
}

describe("ContextManager", () => {
  it("keeps everything when under budget", () => {
    const cm = new ContextManager(10_000);
    const history: ChatMessage[] = [
      system,
      bigUser("hello"),
      { role: "assistant", content: "hi" },
    ];
    const trimmed = cm.trimForRequest(history);
    assert.deepEqual(trimmed, history);
  });

  it("drops the oldest groups first and keeps the system message", () => {
    const cm = new ContextManager(60);
    // each filler user message is ~100 tokens — one group per message
    const history: ChatMessage[] = [
      system,
      bigUser("x".repeat(400)),
      { role: "assistant", content: "a1" },
      bigUser("y".repeat(400)),
      { role: "assistant", content: "a2" },
      bigUser("final question"),
    ];

    const trimmed = cm.trimForRequest(history);

    assert.equal(trimmed[0]?.role, "system");
    assert.ok(!JSON.stringify(trimmed).includes("x".repeat(400))); // oldest evicted
    assert.ok(trimmed.some((m) => m.role === "user" && m.content === "final question"));
  });

  it("never splits a tool result from its tool call", () => {
    const cm = new ContextManager(60);
    const history: ChatMessage[] = [
      system,
      bigUser("z".repeat(400)),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "t", content: "result" },
      bigUser("next"),
    ];

    const trimmed = cm.trimForRequest(history);
    const roles = trimmed.map((m) => m.role);

    // the first group (user + assistant + tool) is evicted whole
    assert.ok(!roles.includes("tool"));
    assert.ok(!roles.includes("assistant"));
  });

  it("always keeps at least the newest group even if oversized", () => {
    const cm = new ContextManager(1);
    const history: ChatMessage[] = [
      system,
      bigUser("huge"),
      { role: "assistant", content: "ok" },
    ];
    const trimmed = cm.trimForRequest(history);
    assert.ok(trimmed.length >= 2); // system + newest group intact
  });

  it("estimateTokens is a positive chars/4 heuristic", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("a".repeat(9)), 3); // ceil
  });
});
