import { test } from "node:test";
import assert from "node:assert/strict";
import { formatName } from "../src/format.mjs";

test("returns empty string for nullish input", () => {
  assert.equal(formatName(null), "");
  assert.equal(formatName(undefined), "");
});

test("formats a normal name", () => {
  assert.equal(formatName("  ada  "), "ADA");
});
