import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ChatMessage } from "../agent/types.js";
import type { ToolSpec } from "../agent/tool.js";
import {
  GeminiCallAccumulator,
  toGeminiRequest,
  toGeminiSchema,
  toGeminiTools,
} from "./gemini-mapping.js";

describe("toGeminiRequest", () => {
  it("moves system text into systemInstruction", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ];
    const { systemInstruction, contents } = toGeminiRequest(messages);
    assert.equal(systemInstruction, "be terse");
    assert.equal(contents.length, 1);
    assert.equal(contents[0]?.role, "user");
  });

  it("joins multiple system messages", () => {
    const { systemInstruction } = toGeminiRequest([
      { role: "system", content: "a" },
      { role: "system", content: "b" },
    ]);
    assert.equal(systemInstruction, "a\nb");
  });

  it("maps assistant turns to the model role with functionCall parts", () => {
    const { contents } = toGeminiRequest([
      {
        role: "assistant",
        content: "reading",
        toolCalls: [{ id: "t1", name: "read_file", arguments: '{"path":"a.txt"}' }],
      },
    ]);
    assert.equal(contents[0]?.role, "model");
    const parts = contents[0]?.parts ?? [];
    assert.deepEqual(parts[0], { text: "reading" });
    assert.deepEqual(parts[1], {
      functionCall: { name: "read_file", args: { path: "a.txt" } },
    });
  });

  it("names each tool result after the call it answers", () => {
    const { contents } = toGeminiRequest([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "t1", content: "file body" },
    ]);
    const userTurn = contents.find((c) => c.role === "user");
    assert.deepEqual(userTurn?.parts, [
      { functionResponse: { name: "read_file", response: { output: "file body" } } },
    ]);
  });

  it("parses invalid tool-call arguments as an empty object", () => {
    const { contents } = toGeminiRequest([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "glob", arguments: "not json" }],
      },
    ]);
    const parts = contents[0]?.parts ?? [];
    assert.deepEqual(parts[0], { functionCall: { name: "glob", args: {} } });
  });

  it("folds adjacent same-role turns into one content", () => {
    const { contents } = toGeminiRequest([
      { role: "user", content: "one" },
      { role: "user", content: "two" },
    ]);
    assert.equal(contents.length, 1);
    assert.equal(contents[0]?.parts?.length, 2);
  });
});

describe("toGeminiSchema", () => {
  it("uppercases type keywords and recurses", () => {
    const converted = toGeminiSchema({
      type: "object",
      properties: {
        path: { type: "string" },
        nested: { type: "array", items: { type: "number" } },
      },
      required: ["path"],
    });
    assert.equal(converted["type"], "OBJECT");
    const properties = converted["properties"] as Record<string, Record<string, unknown>>;
    assert.equal(properties["path"]?.["type"], "STRING");
    assert.equal(properties["nested"]?.["type"], "ARRAY");
    assert.equal(
      (properties["nested"]?.["items"] as Record<string, unknown>)?.["type"],
      "NUMBER",
    );
    assert.deepEqual(converted["required"], ["path"]);
  });

  it("drops JSON-Schema-only keywords Gemini rejects", () => {
    const converted = toGeminiSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
      type: "object",
    });
    assert.equal("$schema" in converted, false);
    assert.equal("additionalProperties" in converted, false);
  });

  it("folds exclusiveMinimum/exclusiveMaximum into inclusive bounds (Gemini 400)", () => {
    const converted = toGeminiSchema({
      type: "object",
      properties: {
        count: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10 },
        // already-inclusive bound must win over the exclusive one
        score: { type: "number", minimum: 0, exclusiveMinimum: -5 },
      },
    });
    assert.equal("exclusiveMinimum" in converted, false);
    assert.equal("exclusiveMaximum" in converted, false);
    const props = converted["properties"] as Record<string, Record<string, unknown>>;
    assert.equal(props["count"]?.["minimum"], 0);
    assert.equal(props["count"]?.["maximum"], 10);
    assert.equal(props["score"]?.["minimum"], 0);
  });

  it("drops $ref/$defs/$anchor that Gemini does not support", () => {
    const converted = toGeminiSchema({
      type: "object",
      properties: { node: { $ref: "#/$defs/node", type: "object" } },
      $defs: { node: { type: "object" } },
    });
    const props = converted["properties"] as Record<string, Record<string, unknown>>;
    assert.equal("$ref" in (props["node"] ?? {}), false);
    assert.equal("$defs" in converted, false);
  });
});

describe("toGeminiTools", () => {
  it("converts a ToolSpec into a function declaration", () => {
    const tools: ToolSpec[] = [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
    const [declaration] = toGeminiTools(tools);
    assert.equal(declaration?.name, "read_file");
    assert.equal(declaration?.description, "Read a file");
    assert.equal(
      (declaration?.parameters as Record<string, unknown>)?.["type"],
      "OBJECT",
    );
  });
});

describe("GeminiCallAccumulator", () => {
  it("returns undefined when no calls were seen", () => {
    assert.equal(new GeminiCallAccumulator().finish(), undefined);
  });

  it("assembles calls in order and lets later chunks overwrite", () => {
    const acc = new GeminiCallAccumulator();
    acc.add([{ name: "read_file", args: { path: "a" } }]);
    acc.add([{ name: "read_file", args: { path: "a.txt" } }]);
    acc.add([
      { name: "read_file", args: { path: "a.txt" } },
      { name: "glob", args: { pattern: "*.md" } },
    ]);
    assert.deepEqual(acc.finish(), [
      { id: "read_file-0", name: "read_file", arguments: '{"path":"a.txt"}' },
      { id: "glob-1", name: "glob", arguments: '{"pattern":"*.md"}' },
    ]);
  });

  it("keeps an id when the provider supplies one", () => {
    const acc = new GeminiCallAccumulator();
    acc.add([{ id: "call_1", name: "run_bash", args: { command: "ls" } }]);
    assert.equal(acc.finish()?.[0]?.id, "call_1");
  });
});
