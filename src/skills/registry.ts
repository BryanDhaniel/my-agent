/**
 * Skill registry — owns the skill namespace.
 *
 * Provides metadata-first access: callers can list lightweight metadata
 * without loading full skill instructions into memory.
 */

import type { Skill, SkillMetadata } from "./loader.js";

export class SkillRegistry {
  #skills = new Map<string, Skill>();

  /** Register a skill. Warns and skips on duplicate names. */
  register(skill: Skill): void {
    if (this.#skills.has(skill.name)) {
      console.error(
        `warning: duplicate skill "${skill.name}" from "${skill.source}" — keeping first registration`,
      );
      return;
    }
    this.#skills.set(skill.name, skill);
  }

  /** Register multiple skills at once. */
  registerAll(skills: Skill[]): void {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  /** Get a skill by name (full instructions included). */
  get(name: string): Skill | undefined {
    return this.#skills.get(name);
  }

  /** Check whether a skill exists. */
  has(name: string): boolean {
    return this.#skills.has(name);
  }

  /** List metadata for all registered skills. */
  list(): SkillMetadata[] {
    return [...this.#skills.values()].map(toMetadata);
  }

  /** List only user-invoked skills. */
  listUserInvoked(): SkillMetadata[] {
    return [...this.#skills.values()]
      .filter((s) => s.invocation === "user")
      .map(toMetadata);
  }

  /** List only model-invoked skills. */
  listModelInvoked(): SkillMetadata[] {
    return [...this.#skills.values()]
      .filter((s) => s.invocation === "model")
      .map(toMetadata);
  }

  /** Total number of registered skills. */
  get size(): number {
    return this.#skills.size;
  }
}

function toMetadata(skill: Skill): SkillMetadata {
  return {
    name: skill.name,
    description: skill.description,
    invocation: skill.invocation,
    source: skill.source,
    ...(skill.argumentHint !== undefined ? { argumentHint: skill.argumentHint } : {}),
  };
}
