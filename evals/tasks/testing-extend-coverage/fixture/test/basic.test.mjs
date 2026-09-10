import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalize } from "../src/stringutils.mjs";

test("capitalize works", () => {
  assert.equal(capitalize("hello"), "Hello");
  assert.equal(capitalize(""), "");
});
