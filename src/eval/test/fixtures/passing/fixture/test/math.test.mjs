import { test } from "node:test";
import assert from "node:assert/strict";
import { double } from "../src/math.mjs";

test("doubles the input", () => {
  assert.equal(double(3), 6);
  assert.equal(double(0), 0);
  assert.equal(double(-4), -8);
});
