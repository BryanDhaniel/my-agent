import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ChatMessage } from "../agent/types.js";
import { extractMemoryCandidates, sentences } from "./extract.js";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });
const tool = (content: string): ChatMessage => ({ role: "tool", toolCallId: "t1", content });

function extract(messages: ChatMessage[]) {
  return extractMemoryCandidates({ messages, sessionId: "s1" });
}

describe("extractMemoryCandidates", () => {
  it("records an explicit request to remember something", () => {
    const found = extract([user("Remember that we deploy on Fridays.")]);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.category, "fact");
    assert.equal(found[0]?.importance, 5);
  });

  it("records stated preferences", () => {
    const found = extract([user("Always run typecheck before committing.")]);
    assert.equal(found[0]?.category, "preference");
    assert.match(found[0]?.content ?? "", /Always run typecheck/);
  });

  it("records project conventions", () => {
    const found = extract([user("By convention, errors are returned not thrown.")]);
    assert.equal(found[0]?.category, "project");
  });

  it("records architectural decisions", () => {
    const found = extract([user("We'll use a greedy allocator instead of fixed buckets.")]);
    assert.equal(found[0]?.category, "decision");
    assert.equal(found[0]?.importance, 5);
  });

  it("records debugging discoveries", () => {
    const found = extract([user("Root cause was a shared temp directory between tests.")]);
    assert.equal(found[0]?.category, "debugging");
  });

  it("trusts only decisions from the agent, at a lower importance", () => {
    const found = extract([assistant("We'll keep the JSONL store for now.")]);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.category, "decision");
    assert.equal(found[0]?.importance, 4, "agent decisions rank below user decisions");
  });

  it("ignores ordinary agent chatter", () => {
    assert.deepEqual(extract([assistant("Let me read the file to see what is going on.")]), []);
  });

  it("never extracts from tool results", () => {
    const found = extract([
      tool("src/context/manager.ts\nWe always use tabs in this repository."),
    ]);
    assert.deepEqual(found, []);
  });

  it("never extracts from system messages", () => {
    assert.deepEqual(
      extract([{ role: "system", content: "Remember that we always use tabs." }]),
      [],
    );
  });

  it("ignores plain requests and questions", () => {
    assert.deepEqual(extract([user("Can you fix the parser?")]), []);
    assert.deepEqual(extract([user("please look at src/agent/types.ts")]), []);
  });

  it("ignores slash commands", () => {
    assert.deepEqual(extract([user("/tdd write the memory layer")]), []);
  });

  it("never extracts a secret", () => {
    const found = extract([user("Remember that the token is ghp_" + "abcdefghijklmnopqrstuvwxyz1234")]);
    assert.deepEqual(found, []);
  });

  it("deduplicates the same sentence seen twice", () => {
    const found = extract([
      user("Always run typecheck."),
      user("always   run typecheck"),
    ]);
    assert.equal(found.length, 1);
  });

  it("caps how much one run can contribute", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push(user(`We always prefer pattern number ${i} here.`));
    }
    assert.equal(extract(messages).length, 5);
  });

  it("is deterministic", () => {
    const messages = [
      user("Always run typecheck."),
      assistant("We'll keep the JSONL store."),
      user("Remember that deploys happen on Fridays."),
    ];
    assert.deepEqual(extract(messages), extract(messages));
  });
});

describe("sentences", () => {
  it("drops questions, slash commands, and oversized prose", () => {
    const out = sentences(
      [
        "We always use tabs.",
        "/tdd build it",
        "Is this right?",
        "x".repeat(300),
        "too short",
      ].join("\n"),
    );
    assert.deepEqual(out, ["We always use tabs."]);
  });
});
