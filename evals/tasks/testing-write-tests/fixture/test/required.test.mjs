import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Guard test: the agent must create a real, non-trivial test file.
// It fails until test/agent.test.mjs exists and looks like a genuine test.
const here = dirname(fileURLToPath(import.meta.url));
const agentTest = join(here, "agent.test.mjs");

test("agent added a non-trivial test file at test/agent.test.mjs", () => {
  assert.ok(existsSync(agentTest), "test/agent.test.mjs must exist");
  const content = readFileSync(agentTest, "utf8");
  assert.ok(content.includes("node:test"), "agent test must use node:test");
  assert.ok(content.includes("import"), "agent test must import the module under test");
  assert.ok(content.length > 80, "agent test should be more than a stub");
});
