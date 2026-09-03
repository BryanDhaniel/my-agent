import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import {
  parseSkill,
  parseSkillMetadata,
  loadSkillFromDir,
  discoverSkillDirs,
  loadAllSkills,
} from "./loader.js";

const VALID_SKILL = `---
name: test-skill
description: A test skill for unit tests.
---

These are the instructions for the test skill.

Be concise and direct.
`;

const USER_INVOKED_SKILL = `---
name: grill-me
description: Grill the user about their plan.
disable-model-invocation: true
argument-hint: "What should I grill you about?"
---

Interview the user relentlessly.
`;

const MINIMAL_SKILL = `---
name: minimal
description: ""
---
`;

describe("parseSkill", () => {
  it("parses a valid SKILL.md with all fields", () => {
    const skill = parseSkill(VALID_SKILL, "/skills/test-skill");
    assert.equal(skill.name, "test-skill");
    assert.equal(skill.description, "A test skill for unit tests.");
    assert.equal(skill.invocation, "model"); // no disable-model-invocation
    assert.equal(skill.source, "/skills/test-skill");
    assert.match(skill.instructions, /These are the instructions/);
    assert.match(skill.instructions, /Be concise and direct/);
  });

  it("parses user-invoked skill with disable-model-invocation and argument-hint", () => {
    const skill = parseSkill(USER_INVOKED_SKILL, "/skills/grill-me");
    assert.equal(skill.name, "grill-me");
    assert.equal(skill.invocation, "user");
    assert.equal(skill.argumentHint, "What should I grill you about?");
  });

  it("parses minimal skill with empty description", () => {
    const skill = parseSkill(MINIMAL_SKILL, "/skills/minimal");
    assert.equal(skill.name, "minimal");
    assert.equal(skill.description, "");
    assert.equal(skill.instructions, "");
    assert.equal(skill.invocation, "model");
  });

  it("throws on missing frontmatter", () => {
    assert.throws(
      () => parseSkill("No frontmatter here", "/bad"),
      /missing YAML frontmatter/,
    );
  });

  it("throws on missing name field", () => {
    const raw = `---
description: No name here
---

Body text.
`;
    assert.throws(
      () => parseSkill(raw, "/bad"),
      /missing "name" field/,
    );
  });

  it("handles quoted description with special characters", () => {
    const raw = `---
name: special
description: "Review changes: standards & spec."
---

Instructions.
`;
    const skill = parseSkill(raw, "/skills/special");
    assert.equal(skill.description, "Review changes: standards & spec.");
  });

  it("handles single-quoted values", () => {
    const raw = `---
name: single-quoted
description: 'A single-quoted description.'
---

Body.
`;
    const skill = parseSkill(raw, "/src");
    assert.equal(skill.description, "A single-quoted description.");
  });
});

describe("parseSkillMetadata", () => {
  it("returns metadata without instructions", () => {
    const meta = parseSkillMetadata(VALID_SKILL, "/skills/test");
    assert.equal(meta.name, "test-skill");
    assert.equal(meta.description, "A test skill for unit tests.");
    assert.equal(meta.invocation, "model");
    assert.equal(meta.source, "/skills/test");
    assert.equal("instructions" in meta, false);
  });
});

describe("loadSkillFromDir", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "skill-loader-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads a skill from a directory containing SKILL.md", async () => {
    const skillDir = join(tmpDir, "my-skill");
    await mkdir(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), VALID_SKILL);

    const skill = await loadSkillFromDir(skillDir);
    assert.equal(skill.name, "test-skill");
    assert.equal(skill.source, skillDir);
  });

  it("throws when SKILL.md is missing", async () => {
    const emptyDir = join(tmpDir, "empty");
    await mkdir(emptyDir);

    await assert.rejects(
      () => loadSkillFromDir(emptyDir),
      /ENOENT/,
    );
  });
});

describe("discoverSkillDirs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "skill-discover-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("finds directories containing SKILL.md", async () => {
    // Create two skill directories and one non-skill directory.
    const skillA = join(tmpDir, "alpha");
    const skillB = join(tmpDir, "beta");
    const notASkill = join(tmpDir, "gamma");

    await mkdir(skillA);
    await mkdir(skillB);
    await mkdir(notASkill);

    await writeFile(join(skillA, "SKILL.md"), VALID_SKILL);
    await writeFile(join(skillB, "SKILL.md"), USER_INVOKED_SKILL);
    await writeFile(join(notASkill, "README.md"), "not a skill");

    const dirs = await discoverSkillDirs(tmpDir);
    assert.equal(dirs.length, 2);
    assert.ok(dirs[0]?.endsWith("alpha"));
    assert.ok(dirs[1]?.endsWith("beta"));
  });

  it("returns empty array for non-existent directory", async () => {
    const dirs = await discoverSkillDirs("/nonexistent/path");
    assert.deepEqual(dirs, []);
  });
});

describe("loadAllSkills", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "skill-loadall-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads all valid skills, skipping broken ones", async () => {
    const good = join(tmpDir, "good");
    const bad = join(tmpDir, "bad");

    await mkdir(good);
    await mkdir(bad);

    await writeFile(join(good, "SKILL.md"), VALID_SKILL);
    await writeFile(join(bad, "SKILL.md"), "broken content with no frontmatter");

    const skills = await loadAllSkills(tmpDir);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "test-skill");
  });
});

describe("real .agents/skills compatibility", () => {
  const skillsRoot = join(
    process.cwd(),
    ".agents",
    "skills",
  );

  it("can parse the implement skill (user-invoked)", async () => {
    const skill = await loadSkillFromDir(join(skillsRoot, "implement"));
    assert.equal(skill.name, "implement");
    assert.equal(skill.invocation, "user");
    assert.ok(skill.instructions.length > 0);
  });

  it("can parse the tdd skill (model-invoked)", async () => {
    const skill = await loadSkillFromDir(join(skillsRoot, "tdd"));
    assert.equal(skill.name, "tdd");
    assert.equal(skill.invocation, "model");
    assert.ok(skill.instructions.length > 0);
  });

  it("can parse the code-review skill (model-invoked, long description)", async () => {
    const skill = await loadSkillFromDir(join(skillsRoot, "code-review"));
    assert.equal(skill.name, "code-review");
    assert.equal(skill.invocation, "model");
    assert.ok(skill.description.length > 20);
  });

  it("discovers all skills in the .agents/skills directory", async () => {
    const dirs = await discoverSkillDirs(skillsRoot);
    assert.ok(dirs.length >= 30); // 36 at time of writing
  });
});
