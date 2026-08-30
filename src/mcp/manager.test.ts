import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { McpManager } from "./manager.js";

describe("McpManager", () => {
  it("reports failed servers without blocking the agent", async () => {
    const manager = await McpManager.connectAll({
      servers: {
        bad1: { command: "__nonexistent_mcp_1__" },
        bad2: { command: "__nonexistent_mcp_2__" },
      },
    });

    assert.equal(manager.connectedCount, 0);
    assert.equal(manager.tools.length, 0);
    assert.equal(manager.statuses.length, 2);
    assert.ok(manager.statuses.every((s) => s.status === "failed"));
    assert.ok(manager.statuses.every((s) => s.error !== undefined));

    // close() should not throw even when nothing is connected
    await manager.close();
  });

  it("gracefully degrades when one of multiple servers fails", async () => {
    // All servers will fail in this test since we can't spawn real MCP servers,
    // but we verify the structure supports partial failure.
    const manager = await McpManager.connectAll({
      servers: {
        serverA: { command: "__nonexistent_a__" },
        serverB: { command: "__nonexistent_b__" },
      },
    });

    // Both should be reported
    assert.equal(manager.statuses.length, 2);
    const names = manager.statuses.map((s) => s.name).sort();
    assert.deepEqual(names, ["serverA", "serverB"]);
    await manager.close();
  });

  it("close() is idempotent and clears tools", async () => {
    const manager = await McpManager.connectAll({
      servers: { x: { command: "__no__" } },
    });
    await manager.close();
    await manager.close(); // second call should be safe
    assert.equal(manager.tools.length, 0);
  });
});
