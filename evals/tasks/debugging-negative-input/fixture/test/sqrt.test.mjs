import { test } from "node:test";
import assert from "node:assert/strict";
import { safeSqrt } from "../src/sqrt.mjs";

test("computes the square root of a non-negative number", () => {
  assert.equal(safeSqrt(0), 0);
  assert.equal(safeSqrt(9), 3);
});

test("throws a clear error for negative input", () => {
  assert.throws(() => safeSqrt(-4), /negative/i);
});
