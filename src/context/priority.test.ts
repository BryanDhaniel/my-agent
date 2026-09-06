import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ChatMessage } from "../agent/types.js";
import {
  CONVERSATION_PRIORITY_NEWEST,
  CONVERSATION_PRIORITY_OLDEST,
  conversationPriority,
  selectWithinBudget,
  splitIntoGroups,
  byPriority,
  type ContextItem,
} from "./priority.js";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

function item(id: string, priority: number, tokens: number, droppable = true): ContextItem {
  return { id, kind: "conversation", priority, tokens, messages: [], droppable };
}

describe("splitIntoGroups", () => {
  it("groups a user message with the messages it triggered", () => {
    const groups = splitIntoGroups([
      user("a"),
      assistant("b"),
      { role: "tool", toolCallId: "1", content: "c" },
      user("d"),
      assistant("e"),
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.length, 3);
    assert.equal(groups[1]?.length, 2);
  });

  it("starts a group for leading non-user messages", () => {
    const groups = splitIntoGroups([assistant("orphan"), user("a")]);
    assert.equal(groups.length, 2);
  });
});

describe("conversationPriority", () => {
  it("decays linearly from newest to oldest", () => {
    assert.equal(conversationPriority(0, 3), CONVERSATION_PRIORITY_NEWEST);
    assert.equal(conversationPriority(1, 3), 300);
    assert.equal(conversationPriority(2, 3), CONVERSATION_PRIORITY_OLDEST);
  });

  it("treats a lone group as the newest", () => {
    assert.equal(conversationPriority(0, 1), CONVERSATION_PRIORITY_NEWEST);
    assert.equal(conversationPriority(0, 0), CONVERSATION_PRIORITY_NEWEST);
  });

  it("clamps out-of-range ages", () => {
    assert.equal(conversationPriority(-5, 3), CONVERSATION_PRIORITY_NEWEST);
    assert.equal(conversationPriority(99, 3), CONVERSATION_PRIORITY_OLDEST);
  });
});

describe("byPriority", () => {
  it("is stable for equal priorities", () => {
    const sorted = byPriority([item("a", 5, 1), item("b", 5, 1), item("c", 9, 1)]);
    assert.deepEqual(sorted.map((i) => i.id), ["c", "a", "b"]);
  });
});

describe("selectWithinBudget", () => {
  it("keeps items in priority order until the input runs out", () => {
    const items = [item("low", 100, 50), item("high", 900, 50), item("mid", 500, 50)];
    const result = selectWithinBudget(items, { input: 120, caps: {} });
    assert.deepEqual(result.kept.map((i) => i.id), ["high", "mid"]);
    assert.deepEqual(result.dropped.map((i) => i.id), ["low"]);
    assert.equal(result.used, 100);
  });

  it("re-emits kept items in canonical order, not selection order", () => {
    const items = [item("a", 100, 10), item("b", 900, 10)];
    const result = selectWithinBudget(items, { input: 100, caps: {} });
    assert.deepEqual(result.kept.map((i) => i.id), ["a", "b"]);
  });

  it("never drops a non-droppable item, even over budget", () => {
    const items = [{ ...item("system", 1000, 500), droppable: false }];
    const result = selectWithinBudget(items, { input: 10, caps: {} });
    assert.deepEqual(result.kept.map((i) => i.id), ["system"]);
    assert.equal(result.used, 500);
  });

  it("caps each kind by its section ceiling", () => {
    const items = [
      { ...item("skill", 800, 90), kind: "skill" as const },
      { ...item("turn", 500, 90), kind: "conversation" as const },
    ];
    const result = selectWithinBudget(items, { input: 100, caps: { skill: 10 } });
    assert.deepEqual(result.kept.map((i) => i.id), ["turn"]);
  });

  it("uses shrink to fit an oversized item", () => {
    const items = [{ ...item("turn", 500, 90), kind: "conversation" as const }];
    const result = selectWithinBudget(items, {
      input: 50,
      caps: {},
      shrink: (candidate, cap) => ({ ...candidate, tokens: cap }),
    });
    assert.deepEqual(result.kept.map((i) => i.id), ["turn"]);
    assert.equal(result.used, 50);
  });

  it("drops an item shrink cannot rescue", () => {
    const items = [item("turn", 500, 90)];
    const result = selectWithinBudget(items, { input: 50, caps: {}, shrink: () => undefined });
    assert.deepEqual(result.kept, []);
    assert.deepEqual(result.dropped.map((i) => i.id), ["turn"]);
  });
});
