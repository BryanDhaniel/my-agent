import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ChatMessage } from "../agent/types.js";
import {
  ContentBlockTracker,
  toAnthropicParams,
  toAnthropicTools,
} from "./anthropic-mapping.js";

describe("toAnthropicParams", () => {
  it("moves system text to the top-level param", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ];
    const { system, messages: mapped } = toAnthropicParams(messages);
    assert.equal(system, "be terse");
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0]?.role, "user");
  });

  it("groups tool results into one user message after their tool calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "t1", name: "read_file", arguments: '{"path":"a.txt"}' },
          { id: "t2", name: "glob", arguments: '{"pattern":"*.md"}' },
        ],
      },
      { role: "tool", toolCallId: "t1", content: "contents" },
      { role: "tool", toolCallId: "t2", content: "./README.md" },
      { role: "assistant", content: "done" },
    ];

    const { messages: mapped } = toAnthropicParams(messages);

    assert.equal(mapped.length, 4);
    assert.equal(mapped[1]?.role, "assistant");
    const assistantBlocks = mapped[1]?.content as Array<{ type: string }>;
    assert.deepEqual(
      assistantBlocks.map((b) => b.type),
      ["tool_use", "tool_use"],
    );

    // both results collapse into a single user turn of tool_result blocks
    assert.equal(mapped[2]?.role, "user");
    const resultBlocks = mapped[2]?.content as Array<{ type: string; tool_use_id: string }>;
    assert.deepEqual(
      resultBlocks.map((b) => b.tool_use_id),
      ["t1", "t2"],
    );
    assert.ok(resultBlocks.every((b) => b.type === "tool_result"));
  });

  it("parses tool_use input and tolerates invalid JSON", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "ok", name: "write_file", arguments: '{"path":"p","content":"c"}' },
          { id: "bad", name: "run_bash", arguments: "{not json" },
        ],
      },
    ];
    const { messages: mapped } = toAnthropicParams(messages);
    const blocks = mapped[1]?.content as Array<{
      type: string;
      id: string;
      input: unknown;
    }>;
    assert.deepEqual(blocks[0]?.input, { path: "p", content: "c" });
    assert.deepEqual(blocks[1]?.input, {});
  });
});

describe("toAnthropicTools", () => {
  it("maps specs to input_schema tools", () => {
    const tools = toAnthropicTools([
      {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    assert.equal(tools[0]?.name, "read_file");
    assert.equal(tools[0]?.input_schema.type, "object");
  });
});

describe("ContentBlockTracker", () => {
  it("assembles scattered json deltas in block order", () => {
    const tracker = new ContentBlockTracker();
    tracker.start(0, "call-a", "write_file");
    tracker.start(1, "call-b", "run_bash");
    tracker.appendJson(1, '{"comm');
    tracker.appendJson(0, '{"pa');
    tracker.appendJson(0, 'th":"x"}');
    tracker.appendJson(1, 'and":"ls"}');

    const calls = tracker.finish();
    assert.ok(calls);
    assert.deepEqual(
      calls.map((c) => c.id),
      ["call-a", "call-b"],
    );
    assert.equal(calls[0]?.arguments, '{"path":"x"}');
    assert.equal(calls[1]?.arguments, '{"command":"ls"}');
  });

  it("returns undefined when no tool blocks appeared", () => {
    assert.equal(new ContentBlockTracker().finish(), undefined);
  });
});
