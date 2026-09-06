import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  budgetCaps,
  DEFAULT_MAX_TOKENS,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  resolveBudget,
} from "./budget.js";

describe("resolveBudget", () => {
  it("reserves output tokens before anything is spent on input", () => {
    const budget = resolveBudget({ maxTokens: 100, reservedOutputTokens: 20 });
    assert.equal(budget.maxTokens, 100);
    assert.equal(budget.reservedOutputTokens, 20);
    assert.equal(budget.input, 80);
  });

  it("splits the input into section ceilings and gives the rest to the conversation", () => {
    const budget = resolveBudget({ maxTokens: 100, reservedOutputTokens: 20 });
    // 80 tokens of input at the default 15/10/10 shares
    assert.equal(budget.system, 12);
    assert.equal(budget.skills, 8);
    assert.equal(budget.memory, 8);
    assert.equal(budget.conversation, 52);
    assert.equal(budget.system + budget.skills + budget.memory + budget.conversation, 80);
  });

  it("scales shares down when they sum above 1", () => {
    const budget = resolveBudget({
      maxTokens: 100,
      reservedOutputTokens: 0,
      systemShare: 0.8,
      skillShare: 0.8,
      memoryShare: 0.8,
    });
    // 100 tokens of input, each share scaled to 0.8/2.4 = one third
    assert.equal(budget.system, 33);
    assert.equal(budget.skills, 33);
    assert.equal(budget.memory, 33);
    assert.equal(budget.conversation, 1);
  });

  it("never reserves more than the whole window", () => {
    const budget = resolveBudget({ maxTokens: 10, reservedOutputTokens: 999 });
    assert.equal(budget.reservedOutputTokens, 10);
    assert.equal(budget.input, 0);
    assert.ok(budget.conversation >= 1);
  });

  it("falls back to defaults for absent or invalid values", () => {
    const budget = resolveBudget({});
    assert.equal(budget.maxTokens, DEFAULT_MAX_TOKENS);
    assert.equal(budget.reservedOutputTokens, DEFAULT_RESERVED_OUTPUT_TOKENS);
    assert.equal(budget.input, DEFAULT_MAX_TOKENS - DEFAULT_RESERVED_OUTPUT_TOKENS);

    const bogus = resolveBudget({
      maxTokens: Number.NaN,
      reservedOutputTokens: -5,
      systemShare: -1,
    });
    assert.equal(bogus.maxTokens, DEFAULT_MAX_TOKENS);
    assert.equal(bogus.reservedOutputTokens, DEFAULT_RESERVED_OUTPUT_TOKENS);
  });
});

describe("budgetCaps", () => {
  it("splits the system share between the instruction kinds", () => {
    const caps = budgetCaps(resolveBudget({ maxTokens: 100, reservedOutputTokens: 20 }));
    // system share is 12 → 50/20/15/15
    assert.equal(caps["system"], 6);
    assert.equal(caps["summary"], 2);
    assert.equal(caps["task"], 1);
    assert.equal(caps["permissions"], 1);
  });

  it("lets the conversation absorb unused slack", () => {
    const budget = resolveBudget({ maxTokens: 100, reservedOutputTokens: 20 });
    const caps = budgetCaps(budget);
    // Capped at the whole input window: selection runs conversation last, so
    // it receives whatever the instruction sections did not spend.
    assert.equal(caps["conversation"], budget.input);
    assert.equal(caps["skill"], budget.skills);
    assert.equal(caps["memory"], budget.memory);
  });
});
