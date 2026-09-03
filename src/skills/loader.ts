/**
 * SKILL.md parser and directory discovery.
 *
 * Parses the mattpocock/skills SKILL.md format:
 * - YAML frontmatter between `---` fences
 * - Markdown body as instructions
 *
 * Frontmatter fields:
 * - `name` (required)
 * - `description` (required)
 * - `disable-model-invocation` (optional, boolean)
 * - `argument-hint` (optional, string)
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface SkillMetadata {
  name: string;
  description: string;
  invocation: "user" | "model";
  source: string;
  argumentHint?: string;
}

export interface Skill extends SkillMetadata {
  instructions: string;
}

/**
 * Parse raw SKILL.md content into a Skill.
 * Throws on invalid frontmatter or missing required fields.
 */
export function parseSkill(raw: string, source: string): Skill {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === undefined) {
    throw new Error(`Skill at "${source}": missing YAML frontmatter`);
  }

  const meta = parseFrontmatter(frontmatter, source);
  return {
    ...meta,
    source,
    instructions: body.trim(),
  };
}

/**
 * Parse only the metadata from raw SKILL.md content (no instructions loaded).
 */
export function parseSkillMetadata(raw: string, source: string): SkillMetadata {
  const { frontmatter } = splitFrontmatter(raw);
  if (frontmatter === undefined) {
    throw new Error(`Skill at "${source}": missing YAML frontmatter`);
  }
  return { ...parseFrontmatter(frontmatter, source), source };
}

/**
 * Load a Skill from a directory containing a SKILL.md file.
 */
export async function loadSkillFromDir(dirPath: string): Promise<Skill> {
  const filePath = path.join(dirPath, "SKILL.md");
  const raw = await readFile(filePath, "utf8");
  return parseSkill(raw, dirPath);
}

/**
 * Discover skill directories under a root.
 * Returns paths to directories that contain a SKILL.md file.
 */
export async function discoverSkillDirs(rootDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return [];
  }

  const dirs: string[] = [];
  for (const entry of entries) {
    const dirPath = path.join(rootDir, entry);
    const skillFile = path.join(dirPath, "SKILL.md");
    try {
      await readFile(skillFile, "utf8");
      dirs.push(dirPath);
    } catch {
      // Not a skill directory — skip.
    }
  }

  return dirs.sort();
}

/**
 * Load all skills from a root directory.
 * Skips directories that fail to parse, logging warnings.
 */
export async function loadAllSkills(rootDir: string): Promise<Skill[]> {
  const dirs = await discoverSkillDirs(rootDir);
  const skills: Skill[] = [];

  for (const dir of dirs) {
    try {
      skills.push(await loadSkillFromDir(dir));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`warning: skipping skill at "${dir}": ${msg}`);
    }
  }

  return skills;
}

// ── Internal helpers ──────────────────────────────────────────────

function splitFrontmatter(raw: string): { frontmatter: string | undefined; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: undefined, body: raw };
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
}

/**
 * Minimal YAML-subset parser for skill frontmatter.
 * Handles flat key: value pairs, quoted strings, and booleans.
 * Does NOT handle nested objects, arrays, or multi-line values.
 */
function parseFrontmatter(yaml: string, source: string): Omit<SkillMetadata, "source"> {
  const fields = new Map<string, string>();

  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Strip surrounding quotes.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    fields.set(key, value);
  }

  const name = fields.get("name");
  if (!name) {
    throw new Error(`Skill at "${source}": frontmatter missing "name" field`);
  }

  const description = fields.get("description") ?? "";

  const disableModel = fields.get("disable-model-invocation");
  const invocation: "user" | "model" =
    disableModel === "true" ? "user" : "model";

  const argumentHint = fields.get("argument-hint");

  return {
    name,
    description,
    invocation,
    ...(argumentHint !== undefined ? { argumentHint } : {}),
  };
}
