import { test } from "node:test";
import assert from "node:assert/strict";
import { runTasks } from "../src/pipeline.mjs";

test("preserves the input order of task results", async () => {
  const tasks = [
    () => Promise.resolve(1),
    () => Promise.resolve(2),
    () => Promise.resolve(3),
  ];
  const out = await runTasks(tasks);
  assert.deepEqual(out, [1, 2, 3]);
});
