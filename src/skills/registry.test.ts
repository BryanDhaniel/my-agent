import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { SkillRegistry } from "./registry.js";
import type { Skill } from "./loader.js";

function fakeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "test-skill",
    description: "A test skill.",
    instructions: "Do the thing.",
    invocation: "model",
    source: "/skills/test-skill",
    ...overrides,
  };
}

describe("SkillRegistry", () => {
  it("registers and retrieves a skill", () => {
    const reg = new SkillRegistry();
    const skill = fakeSkill();
    reg.register(skill);

    assert.deepEqual(reg.get("test-skill"), skill);
    assert.equal(reg.has("test-skill"), true);
    assert.equal(reg.has("nonexistent"), false);
    assert.equal(reg.size, 1);
  });

  it("warns and skips on duplicate name", () => {
    const reg = new SkillRegistry();
    const first = fakeSkill({ source: "/a" });
    const second = fakeSkill({ source: "/b" });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    reg.register(first);
    reg.register(second);

    assert.equal(reg.size, 1);
    assert.equal(reg.get("test-skill")?.source, "/a"); // first wins
    assert.equal(spy.mock.calls.length, 1);
    assert.match(spy.mock.calls[0]?.[0] as string, /duplicate skill/);

    spy.mockRestore();
  });

  it("registerAll registers multiple skills", () => {
    const reg = new SkillRegistry();
    reg.registerAll([
      fakeSkill({ name: "a" }),
      fakeSkill({ name: "b" }),
      fakeSkill({ name: "c" }),
    ]);
    assert.equal(reg.size, 3);
  });

  it("list() returns metadata for all skills", () => {
    const reg = new SkillRegistry();
    reg.register(fakeSkill({ name: "alpha" }));
    reg.register(fakeSkill({ name: "beta", invocation: "user" }));

    const list = reg.list();
    assert.equal(list.length, 2);
    // Metadata should NOT include instructions.
    for (const meta of list) {
      assert.equal("instructions" in meta, false);
    }
  });

  it("listUserInvoked and listModelInvoked filter correctly", () => {
    const reg = new SkillRegistry();
    reg.register(fakeSkill({ name: "user1", invocation: "user" }));
    reg.register(fakeSkill({ name: "user2", invocation: "user" }));
    reg.register(fakeSkill({ name: "model1", invocation: "model" }));

    assert.equal(reg.listUserInvoked().length, 2);
    assert.equal(reg.listModelInvoked().length, 1);
    assert.equal(reg.listModelInvoked()[0]?.name, "model1");
  });

  it("get returns undefined for unknown skill", () => {
    const reg = new SkillRegistry();
    assert.equal(reg.get("ghost"), undefined);
  });

  it("preserves argumentHint in metadata", () => {
    const reg = new SkillRegistry();
    reg.register(fakeSkill({ name: "hinted", argumentHint: "What topic?" }));
    const meta = reg.list();
    assert.equal(meta[0]?.argumentHint, "What topic?");
  });
});
