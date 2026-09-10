import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import type { EvaluationRun } from "./types.js";
import { compareRuns, type RunComparison } from "./metrics.js";

/**
 * Persist evaluation runs so they can be inspected (and compared) later
 * WITHOUT any API calls.
 *
 * Only metadata + metrics are stored — never prompts, fixtures, transcripts or
 * secrets. Results live under ~/.my-agent/evaluations/ by default.
 */
export const DEFAULT_RESULTS_DIR = join(os.homedir(), ".my-agent", "evaluations");

export interface StoredRunMeta {
  id: string;
  createdAt: string;
  provider: string;
  model: string;
  commitSha?: string;
  passed: number;
  total: number;
}

export class EvaluationResultStore {
  readonly dir: string;

  constructor(dir: string = DEFAULT_RESULTS_DIR) {
    this.dir = dir;
  }

  async save(run: EvaluationRun): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${run.id}.json`);
    await writeFile(file, JSON.stringify(run, null, 2), "utf8");
    return file;
  }

  async list(): Promise<StoredRunMeta[]> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
    const metas: StoredRunMeta[] = [];
    for (const file of files) {
      const run = await this.#loadRaw(join(this.dir, file));
      if (run !== undefined) {
        metas.push({
          id: run.id,
          createdAt: run.createdAt,
          provider: run.provider,
          model: run.model,
          ...(run.commitSha !== undefined ? { commitSha: run.commitSha } : {}),
          passed: run.summary.passed,
          total: run.summary.total,
        });
      }
    }
    // Newest first. Sort by createdAt — NOT by filename: run ids are
    // `run_<randomUUID>` and carry no chronological ordering, so a lexical
    // filename sort would yield an arbitrary (and wrong) order for real runs.
    metas.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return metas;
  }

  async load(id: string): Promise<EvaluationRun | undefined> {
    return this.#loadRaw(join(this.dir, `${id}.json`));
  }

  async latest(): Promise<EvaluationRun | undefined> {
    const metas = await this.list();
    if (metas.length === 0) return undefined;
    // list() is already sorted newest-first by createdAt.
    return this.load(metas[0]!.id);
  }

  /** Compare two stored runs by id (no API calls). Returns undefined ids. */
  async compare(ids: [string, string]): Promise<{
    baseline?: EvaluationRun;
    candidate?: EvaluationRun;
    comparison?: RunComparison;
  }> {
    const [baseline, candidate] = await Promise.all([
      this.load(ids[0]),
      this.load(ids[1]),
    ]);
    if (baseline === undefined || candidate === undefined) {
      return { baseline, candidate };
    }
    return { baseline, candidate, comparison: compareRuns(baseline, candidate) };
  }

  async #loadRaw(file: string): Promise<EvaluationRun | undefined> {
    try {
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw) as EvaluationRun;
    } catch {
      return undefined;
    }
  }
}
