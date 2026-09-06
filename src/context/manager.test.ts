import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  ContextManager,
  estimateTokens,
  renderMemoryBlock,
  truncateMiddle,
} from "./manager.js";
import { NoopSummarizer } from "./compaction.js";
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

describe("ContextManager budget", () => {
  it("reserves output tokens so input never fills the window", () => {
    const cm = new ContextManager({ maxTokens: 1_000, reservedOutputTokens: 200 });
    assert.equal(cm.maxTokens, 1_000);
    assert.equal(cm.budget.input, 800);
    assert.equal(cm.getTokenBudget().conversation, 800 - 120 - 80 - 80);
  });

  it("adds the retrieved memories as their own droppable items", () => {
    const cm = new ContextManager({ maxTokens: 10_000 });
    cm.setMemoryContext([
      { id: "m1", content: "the project uses vitest", category: "project" },
    ]);
    const items = cm.prioritize([system, bigUser("hi")]);
    const memory = items.find((i) => i.kind === "memory");
    assert.ok(memory);
    assert.equal(memory.droppable, true);
    assert.equal(memory.priority, 700);
  });

  it("drops memories before it drops the newest turn", () => {
    // 120 tokens of input: memory share is 12, conversation gets the rest.
    const cm = new ContextManager({ maxTokens: 120, reservedOutputTokens: 0 });
    cm.setMemoryContext([{ id: "m1", content: "x".repeat(200) }]); // 50 tokens
    const built = cm.buildContext([bigUser("y".repeat(200))]);
    assert.ok(!built.some((m) => m.content.includes("x".repeat(200))));
    assert.ok(built.some((m) => m.content.includes("y".repeat(200))));
  });
});

describe("ContextManager context sources", () => {
  it("injects task, skills and memories ahead of the conversation", () => {
    const cm = new ContextManager({ maxTokens: 10_000 });
    cm.setTaskContext("Refactor the context layer");
    cm.setPermissionContext("Ask before mutating files.");
    cm.addSkillContext({ name: "tdd", instructions: "Red, green, refactor." });
    cm.setMemoryContext([{ id: "m1", content: "uses vitest", category: "project" }]);

    const built = cm.buildContext([system, bigUser("hello")]);
    const text = built.map((m) => m.content).join("\n");

    assert.match(text, /## Active task\nRefactor the context layer/);
    assert.match(text, /Ask before mutating files\./);
    assert.match(text, /## Skill: tdd\n\nRed, green, refactor\./);
    assert.match(text, /\(project\) uses vitest/);
    // Instructional context comes first so providers that hoist system text
    // keep their ordering stable.
    assert.ok(text.indexOf("## Active task") < text.indexOf("hello"));
    assert.ok(text.indexOf("## Skill: tdd") < text.indexOf("hello"));
  });

  it("only includes skills that were activated, never the whole catalog", () => {
    const cm = new ContextManager({ maxTokens: 10_000 });
    cm.addSkillContext({ name: "tdd", instructions: "Red, green, refactor." });
    const built = cm.buildContext([system, bigUser("hi")]);
    const text = built.map((m) => m.content).join("\n");
    assert.match(text, /Skill: tdd/);
    assert.ok(!text.includes("Skill: research"));
  });

  it("replaces a skill registered twice instead of duplicating it", () => {
    const cm = new ContextManager({ maxTokens: 10_000 });
    cm.addSkillContext({ name: "tdd", instructions: "first" });
    cm.addSkillContext({ name: "tdd", instructions: "second" });
    const built = cm.buildContext([system, bigUser("hi")]);
    const text = built.map((m) => m.content).join("\n");
    assert.ok(!text.includes("first"));
    assert.match(text, /second/);
  });

  it("clearRunContext drops the task and memories but keeps skills", () => {
    const cm = new ContextManager({ maxTokens: 10_000 });
    cm.setTaskContext("do the thing");
    cm.addSkillContext({ name: "tdd", instructions: "Red, green, refactor." });
    cm.setMemoryContext([{ content: "a fact" }]);
    cm.clearRunContext();

    const text = cm.buildContext([system, bigUser("hi")]).map((m) => m.content).join("\n");
    assert.ok(!text.includes("do the thing"));
    assert.ok(!text.includes("a fact"));
    assert.match(text, /Skill: tdd/);
  });

  it("drops an over-budget skill rather than the newest turn", () => {
    // 200 tokens of input → skills share is 20 tokens (80 chars).
    const cm = new ContextManager({ maxTokens: 200, reservedOutputTokens: 0 });
    cm.addSkillContext({ name: "huge", instructions: "z".repeat(400) });
    const built = cm.buildContext([system, bigUser("still here")]);
    const text = built.map((m) => m.content).join("\n");
    assert.ok(!text.includes("z".repeat(400)));
    assert.match(text, /still here/);
  });
});

describe("ContextManager tool results", () => {
  it("truncates an oversized tool result instead of dropping the turn", () => {
    // 900 tokens of input; the newest group's tool result alone is 1 000.
    const cm = new ContextManager({ maxTokens: 900, reservedOutputTokens: 0 });
    const history: ChatMessage[] = [
      system,
      bigUser("q"),
      { role: "assistant", content: "", toolCalls: [{ id: "t", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "t", content: "R".repeat(4_000) },
      bigUser("next"),
    ];

    const built = cm.buildContext(history);
    const toolMessages = built.filter((m) => m.role === "tool");

    assert.equal(toolMessages.length, 1);
    assert.ok(toolMessages[0]!.content.includes("[truncated"));
    assert.ok(toolMessages[0]!.content.length < 4_000);
  });

  it("truncateMiddle keeps the head and tail and reports the cut", () => {
    const out = truncateMiddle("H".repeat(100) + "T".repeat(100), 60);
    assert.ok(out.startsWith("HHH"));
    assert.ok(out.endsWith("TTT"));
    assert.match(out, /\[truncated 172 chars\]/);
    assert.ok(out.length <= 60, `expected <= 60 chars, got ${out.length}`);
  });

  it("leaves a short tool result untouched", () => {
    assert.equal(truncateMiddle("short", 100), "short");
  });
});

describe("ContextManager compaction", () => {
  function longHistory(turns: number, filler = "a".repeat(200)): ChatMessage[] {
    const history: ChatMessage[] = [system];
    for (let i = 0; i < turns; i++) {
      history.push(bigUser(`${filler} ${i}`));
      history.push({ role: "assistant", content: "ok" });
    }
    return history;
  }

  it("reports when the conversation outgrows its budget", () => {
    const cm = new ContextManager({
      maxTokens: 400,
      reservedOutputTokens: 0,
      compactThreshold: 0.5,
    });
    assert.equal(cm.needsCompaction([system, bigUser("tiny")]), false);
    assert.equal(cm.needsCompaction(longHistory(6)), true);
  });

  it("summarizes the older turns and keeps the newest ones", async () => {
    const cm = new ContextManager({
      maxTokens: 400,
      reservedOutputTokens: 0,
      compactThreshold: 0.5,
      protectedGroups: 2,
      keepShare: 0.5,
    });
    const history = longHistory(6);

    const result = await cm.compact(history);
    assert.ok(result);
    assert.ok(result.summarizedMessages > 0);
    assert.ok(result.tokensAfter < result.tokensBefore);

    // The full transcript is untouched — compaction only moves the window.
    assert.equal(history.length, 13);

    const built = cm.buildContext(history);
    const text = built.map((m) => m.content).join("\n");

    assert.match(text, /Earlier in this session \(compacted\)/);
    assert.ok(!text.includes(`${"a".repeat(200)} 0`), "oldest turn is summarized away");
    assert.ok(text.includes(`${"a".repeat(200)} 5`), "newest turn survives");
  });

  it("does not compact a conversation with a single turn group", async () => {
    const cm = new ContextManager({ maxTokens: 100, reservedOutputTokens: 0 });
    assert.equal(await cm.compact([system, bigUser("only one")]), undefined);
  });

  it("folds each compaction into the previous summary", async () => {
    const cm = new ContextManager({
      maxTokens: 400,
      reservedOutputTokens: 0,
      compactThreshold: 0.1,
      protectedGroups: 1,
      keepShare: 0.2,
    });

    const first = await cm.compact(longHistory(4, "first".repeat(40)));
    assert.ok(first);

    // Grow the history again and compact once more.
    const grown: ChatMessage[] = [...longHistory(4, "first".repeat(40))];
    for (let i = 0; i < 4; i++) {
      grown.push({ role: "user", content: `second ${"b".repeat(200)} ${i}` });
      grown.push({ role: "assistant", content: "ok" });
    }
    const second = await cm.compact(grown);
    assert.ok(second);
    assert.ok(second.coveredMessages > first.coveredMessages);
    assert.ok(second.tokensAfter < second.tokensBefore);
  });

  it("restores a summary replayed from the session log", () => {
    const cm = new ContextManager({ maxTokens: 10_000 });
    cm.restoreSummary({
      version: 1,
      task: "resumed task",
      decisions: [],
      importantFacts: ["a remembered fact"],
      completedActions: [],
      pendingActions: [],
      discoveredIssues: [],
      relevantFiles: [],
      coveredMessages: 2,
      createdAt: new Date().toISOString(),
    });

    const built = cm.buildContext([
      system,
      bigUser("old question"),
      { role: "assistant", content: "old answer" },
      bigUser("new question"),
    ]);
    const text = built.map((m) => m.content).join("\n");

    assert.match(text, /a remembered fact/);
    assert.match(text, /new question/);
    assert.ok(!text.includes("old question"), "covered messages stay out of the request");
  });

  it("uses an injected summarizer seam instead of hardcoding extraction", async () => {
    const cm = new ContextManager({
      maxTokens: 400,
      reservedOutputTokens: 0,
      compactThreshold: 0.1,
      summarizer: new NoopSummarizer(),
    });
    const result = await cm.compact(longHistory(4));
    assert.ok(result);
    assert.equal(result.summary.task, "");
    assert.equal(result.summary.importantFacts.length, 0);
  });
});

describe("ContextManager usage accounting", () => {
  it("reports tokens per section and stays inside the input budget", () => {
    const cm = new ContextManager({ maxTokens: 500, reservedOutputTokens: 0 });
    cm.setTaskContext("task");
    cm.addSkillContext({ name: "s", instructions: "i" });
    cm.setMemoryContext([{ id: "m", content: "m" }]);
    const usage = cm.usage(longHistoryForUsage());

    assert.equal(usage.budget.input, 500);
    assert.ok(usage.task > 0);
    assert.ok(usage.skills > 0);
    assert.ok(usage.memory > 0);
    assert.ok(usage.conversation > 0);
    assert.ok(usage.total <= usage.budget.input);

    function longHistoryForUsage(): ChatMessage[] {
      const history: ChatMessage[] = [system];
      for (let i = 0; i < 12; i++) {
        history.push(bigUser(`turn ${i} ${"a".repeat(200)}`));
        history.push({ role: "assistant", content: "ok" });
      }
      return history;
    }
  });
});

describe("renderMemoryBlock", () => {
  it("renders nothing when there are no memories", () => {
    assert.equal(renderMemoryBlock([]), "");
  });

  it("tags each memory with its category", () => {
    const text = renderMemoryBlock([
      { content: "uses pnpm", category: "project" },
      { content: "prefers tabs" },
    ]);
    assert.match(text, /## Memory — durable project knowledge/);
    assert.match(text, /\(project\) uses pnpm/);
    assert.match(text, /^- prefers tabs$/m);
  });
});
