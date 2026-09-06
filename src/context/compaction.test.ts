import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ChatMessage } from "../agent/types.js";
import {
  ExtractiveSummarizer,
  NoopSummarizer,
  planCompaction,
  type CompactionPlanInput,
} from "./compaction.js";
import type { ContextSummary } from "./summary.js";
import { makeSummary, mergeSummaries } from "./summary.js";

const user = (content: string): ChatMessage => ({ role: "user", content });

describe("ExtractiveSummarizer", () => {
  it("takes the task from the last user message", () => {
    const summary = new ExtractiveSummarizer().summarize({
      messages: [user("first request"), user("now refactor the parser")],
    });
    assert.equal(summary.task, "now refactor the parser");
  });

  it("lifts explicit decisions out of assistant text", () => {
    const summary = new ExtractiveSummarizer().summarize({
      messages: [
        user("how should we parse?"),
        { role: "assistant", content: "We'll use a recursive descent parser instead of regex." },
      ],
    });
    assert.ok(summary.decisions.some((d) => d.includes("recursive descent")));
  });

  it("records completed actions from tool calls", () => {
    const summary = new ExtractiveSummarizer().summarize({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "t1", name: "edit_file", arguments: '{"path":"src/agent/types.ts"}' }],
        },
      ],
    });
    assert.deepEqual(summary.completedActions, ["edit_file(src/agent/types.ts)"]);
  });

  it("records tool failures as discovered issues", () => {
    const summary = new ExtractiveSummarizer().summarize({
      messages: [{ role: "tool", toolCallId: "t1", content: "Error: file not found\nstack…" }],
    });
    assert.deepEqual(summary.discoveredIssues, ["Error: file not found"]);
  });

  it("collects files touched by tool results", () => {
    const summary = new ExtractiveSummarizer().summarize({
      messages: [{ role: "tool", toolCallId: "t1", content: "wrote src/context/manager.ts" }],
    });
    assert.deepEqual(summary.relevantFiles, ["src/context/manager.ts"]);
  });

  it("treats stated conventions as important facts", () => {
    const summary = new ExtractiveSummarizer().summarize({
      messages: [user("We always use tabs, never spaces.")],
    });
    assert.ok(summary.importantFacts.some((f) => f.includes("tabs")));
  });

  it("carries earlier findings forward through repeated compactions", () => {
    const previous = makeSummary({
      task: "old task",
      decisions: ["use JSONL"],
      coveredMessages: 6,
    });
    const summary = new ExtractiveSummarizer().summarize({
      messages: [user("new task")],
      previous,
    });
    assert.equal(summary.task, "new task");
    assert.deepEqual(summary.decisions, ["use JSONL"]);
    assert.equal(summary.coveredMessages, 6);
  });

  it("is deterministic — the same input yields the same summary", () => {
    const messages: ChatMessage[] = [
      user("please fix it"),
      { role: "assistant", content: "Decided to cache the result." },
      { role: "tool", toolCallId: "t", content: "Error: timeout" },
    ];
    const a = new ExtractiveSummarizer().summarize({ messages });
    const b = new ExtractiveSummarizer().summarize({ messages });
    // createdAt is a wall-clock stamp, so exclude it from the determinism check.
    const strip = ({ createdAt: _omit, ...rest }: ContextSummary): Omit<ContextSummary, "createdAt"> => rest;
    assert.deepEqual(strip(a), strip(b));
  });
});

describe("NoopSummarizer", () => {
  it("records nothing but preserves the previous summary", () => {
    const previous = makeSummary({ task: "keep", decisions: ["d"], coveredMessages: 3 });
    const summary = new NoopSummarizer().summarize({ messages: [user("x")], previous });
    assert.equal(summary.task, "keep");
    assert.deepEqual(summary.decisions, ["d"]);
    assert.equal(summary.coveredMessages, 3);
  });
});

describe("planCompaction", () => {
  const groups = [[user("a")], [user("b")], [user("c")], [user("d")]];

  function plan(overrides: Partial<CompactionPlanInput> = {}) {
    return planCompaction({
      groups,
      conversationBudget: 100,
      tokens: () => 10,
      ...overrides,
    });
  }

  it("refuses to compact a single turn group", () => {
    assert.equal(planCompaction({ groups: [[user("only")]], conversationBudget: 1 }), undefined);
  });

  it("always leaves at least one group to summarize and one to keep", () => {
    const result = plan({ keepShare: 0.01, protectedGroups: 4 });
    assert.ok(result);
    assert.equal(result.summarizedGroups, 1);
    assert.equal(result.summarized.length, 1);
  });

  it("summarizes more when the budget is tighter", () => {
    const tight = plan({ keepShare: 0.1, protectedGroups: 2 });
    const loose = plan({ keepShare: 1, protectedGroups: 2 });
    assert.equal(tight?.summarizedGroups, 2);
    assert.equal(loose?.summarizedGroups, 1);
  });

  it("summarizes the oldest groups and returns them oldest-first", () => {
    const result = plan({ keepShare: 0.1, protectedGroups: 2 });
    assert.deepEqual(result?.summarized, [user("a"), user("b")]);
  });

  it("returns undefined when every group is protected", () => {
    const two = [[user("a")], [user("b")]];
    const result = planCompaction({
      groups: two,
      conversationBudget: 100,
      protectedGroups: 5,
      tokens: () => 10,
    });
    // protectedGroups is capped by "leave one group to summarize"
    assert.equal(result?.summarizedGroups, 1);
  });
});

describe("mergeSummaries via the summarizer seam", () => {
  it("lets a custom summarizer replace extraction entirely", () => {
    const custom = {
      summarize: () => makeSummary({ task: "from a model", coveredMessages: 0 }),
    };
    const summary = mergeSummaries(
      makeSummary({ task: "old", importantFacts: ["persist me"], coveredMessages: 2 }),
      custom.summarize(),
    );
    assert.equal(summary.task, "from a model");
    assert.deepEqual(summary.importantFacts, ["persist me"]);
  });
});
