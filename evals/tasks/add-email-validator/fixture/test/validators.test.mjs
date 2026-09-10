import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidEmail } from "../src/validators.mjs";

test("accepts simple valid addresses", () => {
  assert.equal(isValidEmail("a@b.com"), true);
  assert.equal(isValidEmail("user.name@mail.co"), true);
});

test("rejects malformed addresses", () => {
  assert.equal(isValidEmail("nope"), false);
  assert.equal(isValidEmail("x@y"), false);
  assert.equal(isValidEmail("a@@b.com"), false);
  assert.equal(isValidEmail("@b.com"), false);
});
