import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { adaptMcpTools, type McpToolDescriptor } from "./adapter.js";

function descriptor(overrides: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    name: overrides.name ?? "search_code",
    description: overrides.description ?? "Search code across repos",
    inputSchema: overrides.inputSchema ?? {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  };
}

describe("adaptMcpTools", () => {
  it("namespaces tool names as mcp.<server>.<tool>", () => {
    const tools = adaptMcpTools("github", [descriptor()], async () => "ok");
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "mcp.github.search_code");
  });

  it("preserves description from the MCP descriptor", () => {
    const tools = adaptMcpTools("gh", [descriptor({ description: "Find code" })], async () => "");
    assert.equal(tools[0]?.description, "Find code");
  });

  it("generates a fallback description when none is provided", () => {
    const tools = adaptMcpTools("db", [{ name: "query" }], async () => "");
    assert.match(tools[0]?.description ?? "", /MCP tool/);
  });

  it("marks all adapted tools as mutating", () => {
    const tools = adaptMcpTools("s", [descriptor(), descriptor({ name: "other" })], async () => "");
    assert.ok(tools.every((t) => t.mutating));
  });

  it("execute delegates to the callTool function with the original tool name", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return "result-text";
    };

    const tools = adaptMcpTools("srv", [descriptor({ name: "run_query" })], callTool);
    const result = await tools[0]!.execute({ query: "SELECT 1" }, { cwd: "/tmp" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, "run_query"); // original, not namespaced
    assert.deepEqual(calls[0]?.args, { query: "SELECT 1" });
    assert.equal(result.output, "result-text");
  });

  it("wraps callTool errors into ToolOutput instead of throwing", async () => {
    const callTool = async () => {
      throw new Error("connection lost");
    };
    const tools = adaptMcpTools("broken", [descriptor()], callTool);
    const result = await tools[0]!.execute({}, { cwd: "/tmp" });
    assert.match(result.output, /Error calling MCP tool/);
    assert.match(result.output, /connection lost/);
  });

  it("handles multiple tools from the same server", () => {
    const descs = [
      descriptor({ name: "tool_a" }),
      descriptor({ name: "tool_b" }),
      descriptor({ name: "tool_c" }),
    ];
    const tools = adaptMcpTools("multi", descs, async () => "");
    assert.equal(tools.length, 3);
    assert.deepEqual(
      tools.map((t) => t.name),
      ["mcp.multi.tool_a", "mcp.multi.tool_b", "mcp.multi.tool_c"],
    );
  });

  it("treats null/undefined input as empty object", async () => {
    const calls: Record<string, unknown>[] = [];
    const callTool = async (_: string, args: Record<string, unknown>) => {
      calls.push(args);
      return "ok";
    };
    const tools = adaptMcpTools("s", [descriptor()], callTool);
    await tools[0]!.execute(undefined, { cwd: "/tmp" });
    assert.deepEqual(calls[0], {});
  });
});
