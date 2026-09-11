import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { EFFORT_LEVELS, isEffort, nextEffort } from "./ink.js";

describe("effort levels", () => {
  it("cycles low -> medium -> high -> xhigh -> max -> low", () => {
    assert.equal(nextEffort("low"), "medium");
    assert.equal(nextEffort("medium"), "high");
    assert.equal(nextEffort("high"), "xhigh");
    assert.equal(nextEffort("xhigh"), "max");
    assert.equal(nextEffort("max"), "low");
  });

  it("validates known levels (and rejects the removed 'ultracode')", () => {
    assert.equal(isEffort("high"), true);
    assert.equal(isEffort("max"), true);
    assert.equal(isEffort("ultracode"), false);
    assert.equal(isEffort("nonsense"), false);
    assert.equal(EFFORT_LEVELS.length, 5);
  });
});
