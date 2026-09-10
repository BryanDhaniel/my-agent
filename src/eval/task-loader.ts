import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EvaluationTask, TaskCategory } from "./types.js";
import { TASK_CATEGORIES } from "./types.js";

/**
 * Load and validate curated tasks from `evals/tasks/<id>/task.json`.
 *
 * Validation is intentional and explicit (not zod) so a malformed task fails
 * with a precise, human-readable message instead of a schema dump.
 */

function isTaskCategory(value: unknown): value is TaskCategory {
  return typeof value === "string" && (TASK_CATEGORIES as readonly string[]).includes(value);
}

function fail(message: string): never {
  throw new Error(`Invalid task: ${message}`);
}

function validateTask(id: string, raw: unknown, source: string): EvaluationTask {
  if (typeof raw !== "object" || raw === null) {
    fail(`${source}: expected a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  if (obj["id"] !== undefined && obj["id"] !== id) {
    fail(`${source}: "id" (${String(obj["id"])}) must match the directory name "${id}"`);
  }
  if (typeof obj["prompt"] !== "string" || obj["prompt"].trim() === "") {
    fail(`${source}: "prompt" is required and must be a non-empty string`);
  }
  if (!isTaskCategory(obj["category"])) {
    fail(
      `${source}: "category" must be one of ${TASK_CATEGORIES.join(", ")} (got ${String(obj["category"])})`,
    );
  }
  const validation = obj["validation"];
  if (typeof validation !== "object" || validation === null) {
    fail(`${source}: "validation" object is required`);
  }
  const v = validation as Record<string, unknown>;
  if (typeof v["command"] !== "string" || v["command"].trim() === "") {
    fail(`${source}: "validation.command" is required and must be a non-empty string`);
  }
  if (v["cwd"] !== undefined && typeof v["cwd"] !== "string") {
    fail(`${source}: "validation.cwd" must be a string`);
  }
  if (v["timeoutMs"] !== undefined && typeof v["timeoutMs"] !== "number") {
    fail(`${source}: "validation.timeoutMs" must be a number`);
  }
  if (obj["fixture"] !== undefined && typeof obj["fixture"] !== "string") {
    fail(`${source}: "fixture" must be a string`);
  }
  if (obj["maxTurns"] !== undefined && typeof obj["maxTurns"] !== "number") {
    fail(`${source}: "maxTurns" must be a number`);
  }

  return {
    id,
    category: obj["category"],
    prompt: obj["prompt"],
    ...(obj["fixture"] !== undefined ? { fixture: obj["fixture"] } : {}),
    ...(typeof obj["maxTurns"] === "number" ? { maxTurns: obj["maxTurns"] } : {}),
    validation: {
      command: v["command"],
      ...(typeof v["cwd"] === "string" ? { cwd: v["cwd"] } : {}),
      ...(typeof v["timeoutMs"] === "number" ? { timeoutMs: v["timeoutMs"] } : {}),
    },
    ...(typeof obj["notes"] === "string" ? { notes: obj["notes"] } : {}),
  };
}

/** List task ids (directory names that contain a `task.json`). */
export async function listTasks(tasksDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(tasksDir, entry.name, "task.json"))) ids.push(entry.name);
  }
  return ids.sort();
}

/** Load a single task, validating its shape. */
export async function loadTask(id: string, tasksDir: string): Promise<EvaluationTask> {
  const file = join(tasksDir, id, "task.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`Task not found: ${id} (missing ${file})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Task ${id}: task.json is not valid JSON — ${(err as Error).message}`);
  }
  return validateTask(id, parsed, file);
}

/** Resolve the fixture source directory for a task (may not exist). */
export function resolveFixturePath(task: EvaluationTask, tasksDir: string): string {
  const sub = task.fixture ?? "fixture";
  return join(tasksDir, task.id, sub);
}
