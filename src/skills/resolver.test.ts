import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { SkillRegistry } from "./registry.js";
import { SkillResolver, SkillResolverError, MAX_DEPTH } from "./resolver.js";
import type { Skill } from "./loader.js";

function fakeSkill(name: string): Skill {
  return {
    name,
    description: `The ${name} skill.`,
    instructions: `Instructions for ${name}.`,
    invocation: "model",
    source: `/skills/${name}`,
  };
}

describe("SkillResolver", () => {
  it("resolves a known skill", () => {
    const reg = new SkillRegistry();
    reg.register(fakeSkill("tdd"));
    const resolver = new SkillResolver(reg);

    const skill = resolver.resolve("tdd");
    assert.equal(skill.name, "tdd");
    assert.equal(skill.instructions, "Instructions for tdd.");
  });

  it("throws SkillResolverError for unknown skill", () => {
    const reg = new SkillRegistry();
    const resolver = new SkillResolver(reg);

    assert.throws(
      () => resolver.resolve("nonexistent"),
      (err: unknown) =>
        err instanceof SkillResolverError && /Unknown skill/.test(err.message),
    );
  });

  it("throws SkillResolverError when depth exceeds MAX_DEPTH", () => {
    const reg = new SkillRegistry();
    reg.register(fakeSkill("deep"));
    const resolver = new SkillResolver(reg);

    // Depth 0, 1, 2 should work; depth 3 should fail.
    assert.doesNotThrow(() => resolver.resolve("deep", 0));
    assert.doesNotThrow(() => resolver.resolve("deep", 1));
    assert.doesNotThrow(() => resolver.resolve("deep", MAX_DEPTH - 1));

    assert.throws(
      () => resolver.resolve("deep", MAX_DEPTH),
      (err: unknown) =>
        err instanceof SkillResolverError && /depth exceeded/.test(err.message),
    );
  });

  it("MAX_DEPTH is 3", () => {
    assert.equal(MAX_DEPTH, 3);
  });
});
