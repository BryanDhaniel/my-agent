import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { paperWidth, ruleLine, wrapPaper } from "./theme.js";

describe("wrapPaper", () => {
  it("wraps at the width boundary on spaces", () => {
    assert.deepEqual(wrapPaper("one two three four five", 8), [
      "one two",
      "three",
      "four",
      "five",
    ]);
    assert.deepEqual(wrapPaper("aa bb cc dd", 5), ["aa bb", "cc dd"]);
  });

  it("hard-breaks words longer than the width", () => {
    const lines = wrapPaper("abcdefghij", 4);
    assert.deepEqual(lines, ["abcd", "efgh", "ij"]);
  });

  it("keeps blank lines as paragraph space", () => {
    const lines = wrapPaper("a\n\nb", 10);
    assert.deepEqual(lines, ["a", "", "b"]);
  });

  it("leaves short lines untouched and normalizes runs of spaces", () => {
    assert.deepEqual(wrapPaper("hello   world", 40), ["hello world"]);
  });
});

describe("paper geometry", () => {
  it("paperWidth treats degenerate columns as 80 and caps at maxWidth", () => {
    assert.equal(paperWidth(0), 74); // 80 - 2*3 margin
    assert.equal(paperWidth(undefined), 74);
    assert.equal(paperWidth(200), 84); // maxWidth cap
    assert.ok(paperWidth(30) >= 20); // floor
  });

  it("ruleLine matches paperWidth", () => {
    assert.equal(ruleLine("light", 200).length, 84);
  });
});
