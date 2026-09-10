import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupe } from "../src/collections.mjs";

test("removes all duplicates, keeping first-seen order", () => {
  assert.deepEqual(dedupe([1, 1, 2, 2, 3, 1]), [1, 2, 3]);
  assert.deepEqual(dedupe(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);
  assert.deepEqual(dedupe([]), []);
  assert.deepEqual(dedupe([5]), [5]);
});
