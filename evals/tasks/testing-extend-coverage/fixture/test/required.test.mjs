import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Guard test: the agent must add coverage for truncate/repeat.
// It fails until test/extra.test.mjs exists and exercises those functions.
const here = dirname(fileURLToPath(import.meta.url));
const extraTest = join(here, "extra.test.mjs");

test("agent added test/extra.test.mjs covering truncate and repeat", () => {
  assert.ok(existsSync(extraTest), "test/extra.test.mjs must exist");
  const content = readFileSync(extraTest, "utf8");
  assert.ok(content.includes("node:test"), "extra test must use node:test");
  assert.ok(content.includes("truncate"), "extra test must cover truncate");
  assert.ok(content.includes("repeat"), "extra test must cover repeat");
  assert.ok(content.length > 80, "extra test should be more than a stub");
});
