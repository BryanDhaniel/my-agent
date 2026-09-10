import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Isolated fixture handling.
 *
 * Every task runs in a fresh temp directory copied from its fixture source, so
 * the agent's writes never pollute the curated dataset and tasks cannot leak
 * state into one another. `cleanup()` removes the temp dir; callers MUST await
 * it (eval wraps each task so a failure still cleans up).
 */
export interface PreparedFixture {
  dir: string;
  cleanup(): Promise<void>;
}

export async function prepareFixture(fixtureSrc?: string): Promise<PreparedFixture> {
  const dir = await mkdtemp(join(tmpdir(), "my-agent-eval-"));
  if (fixtureSrc !== undefined && existsSync(fixtureSrc)) {
    await cp(fixtureSrc, dir, { recursive: true });
  }
  return {
    dir,
    async cleanup(): Promise<void> {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
