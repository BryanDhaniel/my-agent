import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  emptySummary,
  extractFilePaths,
  isContextSummary,
  isEmptySummary,
  makeSummary,
  mergeSummaries,
  renderSummary,
  SUMMARY_VERSION,
} from "./summary.js";

describe("ContextSummary", () => {
  it("serializes and recovers through JSON", () => {
    const summary = makeSummary({
      task: "Refactor the context layer",
      decisions: ["Use a greedy allocator"],
      relevantFiles: ["src/context/manager.ts"],
      coveredMessages: 7,
    });
    const round = JSON.parse(JSON.stringify(summary));
    assert.ok(isContextSummary(round));
    assert.deepEqual(round, summary);
    assert.equal(round.version, SUMMARY_VERSION);
  });

  it("rejects values that are not summaries", () => {
    assert.equal(isContextSummary(undefined), false);
    assert.equal(isContextSummary("nope"), false);
    assert.equal(isContextSummary({ task: "only a task" }), false);
  });

  it("isEmptySummary only reports a summary with no content", () => {
    assert.equal(isEmptySummary(emptySummary()), true);
    assert.equal(isEmptySummary(makeSummary({ task: "do the thing" })), false);
    assert.equal(isEmptySummary(makeSummary({ discoveredIssues: ["boom"] })), false);
  });

  it("makeSummary clamps coveredMessages and stamps a timestamp", () => {
    const summary = makeSummary({ coveredMessages: -4 });
    assert.equal(summary.coveredMessages, 0);
    assert.ok(!Number.isNaN(Date.parse(summary.createdAt)));
  });
});

describe("mergeSummaries", () => {
  it("folds a newer summary over an older one", () => {
    const previous = makeSummary({
      task: "old task",
      decisions: ["keep me"],
      importantFacts: ["fact one"],
      coveredMessages: 4,
    });
    const next = makeSummary({
      task: "new task",
      importantFacts: ["fact two"],
      coveredMessages: 9,
    });

    const merged = mergeSummaries(previous, next);

    assert.equal(merged.task, "new task");
    assert.deepEqual(merged.decisions, ["keep me"]);
    assert.deepEqual(merged.importantFacts, ["fact two", "fact one"]);
    assert.equal(merged.coveredMessages, 9);
  });

  it("keeps the older task when the newer summary has none", () => {
    const merged = mergeSummaries(makeSummary({ task: "old task" }), makeSummary({}));
    assert.equal(merged.task, "old task");
  });

  it("dedupes and caps each list", () => {
    const previous = makeSummary({ decisions: ["same", "a", "b"] });
    const next = makeSummary({ decisions: ["same", "c"] });
    const merged = mergeSummaries(previous, next);
    assert.deepEqual(merged.decisions.slice(0, 3), ["same", "c", "a"]);
    assert.equal(new Set(merged.decisions).size, merged.decisions.length);
  });

  it("returns the next summary untouched when there is no previous", () => {
    const next = makeSummary({ task: "first" });
    assert.equal(mergeSummaries(undefined, next), next);
  });
});

describe("renderSummary", () => {
  it("renders every populated section and skips empty ones", () => {
    const text = renderSummary(
      makeSummary({
        task: "Ship the memory layer",
        decisions: ["JSONL store"],
        relevantFiles: ["src/memory/store.ts"],
      }),
    );
    assert.match(text, /Ship the memory layer/);
    assert.match(text, /Decisions:/);
    assert.match(text, /- JSONL store/);
    assert.match(text, /Files:/);
    assert.ok(!text.includes("Pending:"));
  });
});

describe("extractFilePaths", () => {
  it("finds path-like tokens with an extension", () => {
    const found = extractFilePaths("edited src/context/manager.ts and src/agent/types.ts twice");
    assert.deepEqual(found, ["src/context/manager.ts", "src/agent/types.ts"]);
  });

  it("ignores urls and bare words", () => {
    const found = extractFilePaths("see https://example.com/a.ts and just-a-word");
    assert.deepEqual(found, []);
  });
});
