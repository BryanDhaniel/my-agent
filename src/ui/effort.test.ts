import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { EFFORT_DESCRIPTIONS, EFFORT_LEVELS, isEffort } from "./ink.js";

describe("effort levels", () => {
  it("validates known levels (and rejects the removed 'ultracode')", () => {
    assert.equal(isEffort("high"), true);
    assert.equal(isEffort("max"), true);
    assert.equal(isEffort("ultracode"), false);
    assert.equal(isEffort("nonsense"), false);
    assert.equal(EFFORT_LEVELS.length, 5);
  });

  it("describes every level (used by the /effort picker)", () => {
    for (const level of EFFORT_LEVELS) {
      assert.equal(typeof EFFORT_DESCRIPTIONS[level], "string");
      assert.ok(EFFORT_DESCRIPTIONS[level].length > 0);
    }
  });
});
