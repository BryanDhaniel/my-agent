import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { SLASH_COMMANDS, suggestCommands } from "./commands.js";

describe("suggestCommands", () => {
  it("shows everything for a bare slash", () => {
    const names = suggestCommands("/").map((c) => c.name);
    assert.deepEqual(names, SLASH_COMMANDS.map((c) => c.name));
  });

  it("filters by prefix", () => {
    assert.deepEqual(
      suggestCommands("/se").map((c) => c.name),
      ["session"],
    );
    assert.deepEqual(
      suggestCommands("/E").map((c) => c.name),
      ["effort", "exit"], // "/e" now matches both, in declaration order
    );
  });

  it("deactivates once there is a space, or no slash", () => {
    assert.equal(suggestCommands("/exit now").length, 0);
    assert.equal(suggestCommands("hello /e").length, 0);
  });

  it("returns nothing for unknown prefixes", () => {
    assert.deepEqual(suggestCommands("/zzz"), []);
  });

  it("includes extra skill commands in suggestions", () => {
    const extra = [{ name: "tdd", description: "Test-driven dev." }];
    const names = suggestCommands("/t", extra).map((c) => c.name);
    assert.ok(names.includes("tdd"));
  });

  it("matches hyphenated skill names", () => {
    const extra = [{ name: "grill-me", description: "Grill." }];
    const names = suggestCommands("/grill-", extra).map((c) => c.name);
    assert.deepEqual(names, ["grill-me"]);
  });
});
