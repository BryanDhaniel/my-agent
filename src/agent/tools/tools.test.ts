import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { globToRegExp } from "./glob-to-regexp.js";
import { defaultRegistry } from "./index.js";
import type { ToolContext } from "../tool.js";

const dirs: string[] = [];

async function fixture(): Promise<{ dir: string; ctx: ToolContext }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "my-agent-tools-"));
  dirs.push(dir);
  await mkdir(path.join(dir, "src", "nested"), { recursive: true });
  await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\nconst apple = 2;\n");
  await writeFile(path.join(dir, "src", "nested", "b.ts"), "export const b = 'berry';\n");
  await writeFile(path.join(dir, "README.md"), "# hello world\n");
  await writeFile(path.join(dir, "package.json"), "{}\n");
  return { dir, ctx: { cwd: dir } };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => import("node:fs/promises").then((fs) => fs.rm(d, { recursive: true, force: true }))));
});

describe("globToRegExp", () => {
  it("handles star, doublestar, and question mark", () => {
    assert.ok(globToRegExp("*.ts").test("a.ts"));
    assert.ok(!globToRegExp("*.ts").test("dir/a.ts"));
    assert.ok(globToRegExp("**/*.ts").test("deep/nested/a.ts"));
    assert.ok(globToRegExp("**/*.ts").test("a.ts"));
    assert.ok(globToRegExp("src/**/*.ts").test("src/nested/b.ts"));
    assert.ok(!globToRegExp("src/**/*.ts").test("other/b.ts"));
    assert.ok(globToRegExp("a?c").test("abc"));
    assert.ok(!globToRegExp("a?c").test("a/c"));
  });
});

describe("tool registry integration", () => {
  it("glob finds files by pattern", async () => {
    const { ctx } = await fixture();
    const registry = defaultRegistry();

    const result = await registry.invoke("glob", JSON.stringify({ pattern: "src/**/*.ts" }), ctx);
    const lines = result.output.split("\n").filter((l) => l.startsWith("./"));
    assert.equal(lines.length, 2);
    assert.ok(lines.some((l) => l.includes("nested/b.ts")));
  });

  it("grep searches contents with include filter", async () => {
    const { ctx } = await fixture();
    const registry = defaultRegistry();

    const result = await registry.invoke(
      "grep",
      JSON.stringify({ pattern: "berry", include: "*.ts" }),
      ctx,
    );
    assert.match(result.output, /b\.ts:1/);
  });

  it("run_bash captures stdout and exit codes", async () => {
    const { ctx } = await fixture();
    const registry = defaultRegistry();

    const ok = await registry.invoke("run_bash", JSON.stringify({ command: "echo hello" }), ctx);
    assert.match(ok.output, /exit code: 0/);
    assert.match(ok.output, /hello/);

    const fail = await registry.invoke("run_bash", JSON.stringify({ command: "false" }), ctx);
    assert.match(fail.output, /exit code: (?!0)/);
  });

  it("edit_file replaces exactly once and refuses ambiguity", async () => {
    const { dir, ctx } = await fixture();
    const registry = defaultRegistry();

    const ok = await registry.invoke(
      "edit_file",
      JSON.stringify({ path: "src/a.ts", oldText: "apple = 2", newText: "avocado = 3" }),
      ctx,
    );
    assert.ok(ok.output.startsWith("Edited"));
    const edited = await readFile(path.join(dir, "src", "a.ts"), "utf8");
    assert.match(edited, /avocado = 3/);

    const missing = await registry.invoke(
      "edit_file",
      JSON.stringify({ path: "src/a.ts", oldText: "not present anywhere", newText: "x" }),
      ctx,
    );
    assert.match(missing.output, /not found/);

    const dup = path.join(dir, "dup.txt");
    await writeFile(dup, "same\nsame\n");
    const ambiguous = await registry.invoke(
      "edit_file",
      JSON.stringify({ path: "dup.txt", oldText: "same", newText: "diff" }),
      ctx,
    );
    assert.match(ambiguous.output, /multiple times/);
  });

  it("rejects invalid arguments with helpful output", async () => {
    const { ctx } = await fixture();
    const registry = defaultRegistry();
    const result = await registry.invoke("read_file", JSON.stringify({ nope: true }), ctx);
    assert.match(result.output, /invalid arguments/);
  });
});
