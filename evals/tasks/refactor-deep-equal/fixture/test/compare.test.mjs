import { test } from "node:test";
import assert from "node:assert/strict";
import { deepEqual } from "../src/compare.mjs";

test("treats structurally equal nested objects as equal", () => {
  assert.equal(deepEqual({ a: { b: 1 } }, { a: { b: 1 } }), true);
  assert.equal(deepEqual({ a: [1, 2] }, { a: [1, 2] }), true);
});

test("detects nested differences", () => {
  assert.equal(deepEqual({ a: { b: 1 } }, { a: { b: 2 } }), false);
  assert.equal(deepEqual({ a: [1, 2] }, { a: [1, 3] }), false);
});
