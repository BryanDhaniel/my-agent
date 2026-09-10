import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "../src/sum.mjs";

test("sums every element", () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([10, 20, 30, 40]), 100);
  assert.equal(sum([]), 0);
  assert.equal(sum([5]), 5);
});
