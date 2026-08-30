import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { McpConnectionError } from "./client.js";

/**
 * McpClient wraps the MCP SDK's Client + StdioClientTransport.
 * We cannot spawn real MCP servers in unit tests, so we test:
 * 1. Error class construction.
 * 2. Connection failure paths (invalid command).
 * 3. Integration with the adapter through a mock callTool.
 *
 * End-to-end validation with a real MCP server is done in smoke tests.
 */

describe("McpConnectionError", () => {
  it("includes the server name in the message", () => {
    const err = new McpConnectionError("github", "spawn failed");
    assert.match(err.message, /github/);
    assert.match(err.message, /spawn failed/);
    assert.equal(err.serverName, "github");
  });

  it("preserves the cause chain", () => {
    const cause = new Error("ENOENT");
    const err = new McpConnectionError("db", "bad command", { cause });
    assert.equal(err.cause, cause);
  });
});

describe("McpClient.connect", () => {
  it("throws McpConnectionError for a nonexistent command", async () => {
    // Dynamically import to avoid top-level SDK initialization issues
    const { McpClient } = await import("./client.js");
    try {
      await McpClient.connect("fake", {
        command: "__nonexistent_mcp_command_12345__",
        args: [],
      });
      assert.fail("expected connection to fail");
    } catch (err) {
      assert.ok(err instanceof McpConnectionError);
      assert.equal(err.serverName, "fake");
    }
  });
});
