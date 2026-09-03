/**
 * Skill resolver — resolves skill names with composition depth protection.
 *
 * Prevents recursive skill loops (A → B → C → A) by tracking depth
 * and refusing to resolve beyond MAX_DEPTH.
 */

import type { Skill } from "./loader.js";
import type { SkillRegistry } from "./registry.js";

/** Maximum composition depth to prevent infinite skill loops. */
export const MAX_DEPTH = 3;

export class SkillResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillResolverError";
  }
}

export class SkillResolver {
  #registry: SkillRegistry;

  constructor(registry: SkillRegistry) {
    this.#registry = registry;
  }

  /**
   * Resolve a skill by name.
   *
   * @param name  Skill name to resolve.
   * @param depth Current composition depth (0 = top-level invocation).
   * @throws {SkillResolverError} If skill is not found or depth exceeded.
   */
  resolve(name: string, depth = 0): Skill {
    if (depth >= MAX_DEPTH) {
      throw new SkillResolverError(
        `Skill composition depth exceeded (max ${MAX_DEPTH}): "${name}"`,
      );
    }

    const skill = this.#registry.get(name);
    if (!skill) {
      throw new SkillResolverError(`Unknown skill: "${name}"`);
    }

    return skill;
  }
}
