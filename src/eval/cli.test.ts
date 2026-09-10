import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { runEvalCli } from "./cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "test", "fixtures");

let resultsDir: string;
let stdout: string[];
let stderr: string[];
const realWriteOut = process.stdout.write.bind(process.stdout);
const realWriteErr = process.stderr.write.bind(process.stderr);

beforeEach(async () => {
  resultsDir = await mkdtemp(join(tmpdir(), "eval-cli-"));
  stdout = [];
  stderr = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  await rm(resultsDir, { recursive: true, force: true });
  process.stdout.write = realWriteOut;
  process.stderr.write = realWriteErr;
});

function out(): string {
  return stdout.join("");
}

describe("runEvalCli", () => {
  it("lists available tasks without API calls", async () => {
    const code = await runEvalCli(["--list-tasks", "--tasks-dir", FIXTURES]);
    expect(code).toBe(0);
    expect(out()).toContain("passing");
    expect(out()).toContain("broken");
  });

  it("plans a dry run and makes no API calls", async () => {
    const code = await runEvalCli([
      "--dry-run",
      "--tasks-dir",
      FIXTURES,
      "--results-dir",
      resultsDir,
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out());
    expect(parsed.dryRun).toBe(true);
    expect(parsed.tasks.every((t: { status: string }) => t.status === "skipped")).toBe(true);
  });

  it("refuses a real run without an API key and without --yes", async () => {
    const code = await runEvalCli([
      "--provider",
      "openai",
      "--tasks-dir",
      FIXTURES,
      "--results-dir",
      resultsDir,
      "--tasks",
      "passing",
    ]);
    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/API key/i);
  });

  it("reports unknown flags", async () => {
    const code = await runEvalCli(["--bogus"]);
    expect(code).toBe(2);
  });
});
