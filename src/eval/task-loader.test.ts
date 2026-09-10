import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { listTasks, loadTask } from "./task-loader.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "test", "fixtures");

describe("task-loader", () => {
  it("lists task ids discovered in the fixtures dir", async () => {
    const ids = await listTasks(FIXTURES);
    expect(ids).toContain("passing");
    expect(ids).toContain("broken");
  });

  it("loads and validates a well-formed task", async () => {
    const task = await loadTask("passing", FIXTURES);
    expect(task.id).toBe("passing");
    expect(task.category).toBe("bug-fix");
    expect(task.validation.command).toBe("node --test");
  });

  it("rejects a task whose category is unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-loader-"));
    try {
      await mkdir(join(dir, "bad"), { recursive: true });
      await writeFile(
        join(dir, "bad", "task.json"),
        JSON.stringify({ id: "bad", category: "nope", prompt: "x", validation: { command: "true" } }),
      );
      await expect(loadTask("bad", dir)).rejects.toThrow(/category/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a task missing a validation command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-loader-"));
    try {
      await mkdir(join(dir, "bad"), { recursive: true });
      await writeFile(
        join(dir, "bad", "task.json"),
        JSON.stringify({ id: "bad", category: "bug-fix", prompt: "x" }),
      );
      await expect(loadTask("bad", dir)).rejects.toThrow(/validation/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
