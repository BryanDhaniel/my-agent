import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  API_KEY_ENV,
  DEFAULT_MODELS,
  isProviderName,
  type ProviderName,
} from "../config.js";
import { buildPricingRegistry } from "./pricing.js";
import { EvaluationResultStore, DEFAULT_RESULTS_DIR } from "./result-store.js";
import { EvaluationRunner } from "./runner.js";
import { listTasks, loadTask } from "./task-loader.js";
import type { EvaluationRun, TaskResult } from "./types.js";

/**
 * `my-agent eval` — a CLI that drives the real AgentHarness over curated tasks.
 *
 * Design rules honoured here:
 *  - `--dry-run` makes ZERO API calls (no provider is constructed).
 *  - `npm test` never reaches the API; results can be inspected offline via
 *    `--results` and `--compare-runs`.
 *  - conservative defaults: sequential, no auto-repeat, turn cap, and a
 *    cost-safety confirmation before any real (billed) run.
 */
export interface EvalCliArgs {
  provider?: string;
  model?: string;
  compare?: string[];
  tasks?: string[];
  tasksDir?: string;
  resultsDir?: string;
  dryRun?: boolean;
  results?: boolean;
  compareRuns?: [string, string];
  listTasks?: boolean;
  json?: boolean;
  pricing?: string;
  maxTurns?: number;
  yes?: boolean;
  help?: boolean;
}

const HELP = `my-agent eval — run curated tasks through the real AgentHarness

Usage:
  my-agent eval [options]

Options:
  --provider <name>      Provider to run (openai|anthropic|gemini|glm).
  --model <id>           Model id (defaults to the provider default).
  --compare <p...>       Run the same task set across several providers and
                         print a side-by-side comparison.
  --tasks <id,id>        Run only these task ids (default: all discovered).
  --tasks-dir <path>     Task dataset directory (default: ./evals/tasks).
  --results-dir <path>   Where runs are stored (default: ~/.my-agent/evaluations).
  --dry-run              Plan the run; make NO API calls.
  --results             List previously stored runs (no API calls).
  --compare-runs <a> <b> Compare two stored runs (no API calls).
  --list-tasks          List available task ids (no API calls).
  --pricing <default|file.json>  Enable estimated cost (default: "unknown").
  --max-turns <n>        Per-task turn cap (default: 25).
  --json                 Emit JSON instead of a formatted report.
  --yes                 Skip the cost-safety confirmation for real runs.
  --help                 Show this help.
`;

export async function runEvalCli(argv: string[]): Promise<number> {
  let args: EvalCliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }

  const store = new EvaluationResultStore(args.resultsDir ?? DEFAULT_RESULTS_DIR);
  const tasksDir = resolveTasksDir(args.tasksDir);

  if (args.results) return await cmdResults(store, args.json);
  if (args.compareRuns) return await cmdCompareRuns(store, args.compareRuns, args.json);
  if (args.listTasks) return await cmdListTasks(tasksDir);

  // A real (or dry) run.
  const pricing = resolvePricing(args.pricing);
  const requestedIds = args.tasks ?? [];

  if (args.compare && args.compare.length > 0) {
    return await cmdCompare(store, tasksDir, args, pricing, requestedIds);
  }
  return await cmdRun(store, tasksDir, args, pricing, requestedIds);
}

// ---- commands -------------------------------------------------------------

async function cmdResults(store: EvaluationResultStore, json?: boolean): Promise<number> {
  const runs = await store.list();
  if (json) {
    process.stdout.write(JSON.stringify(runs, null, 2) + "\n");
    return 0;
  }
  if (runs.length === 0) {
    process.stdout.write("No stored evaluation runs yet.\n");
    return 0;
  }
  process.stdout.write("Stored evaluation runs (newest first):\n");
  for (const r of runs) {
    const sha = r.commitSha ? ` @ ${r.commitSha.slice(0, 9)}` : "";
    process.stdout.write(
      `  ${r.id}  ${r.provider}/${r.model}${sha}  ${r.passed}/${r.total} passed\n`,
    );
  }
  return 0;
}

async function cmdCompareRuns(
  store: EvaluationResultStore,
  ids: [string, string],
  json?: boolean,
): Promise<number> {
  const { baseline, candidate, comparison } = await store.compare(ids);
  if (baseline === undefined) {
    process.stderr.write(`Run not found: ${ids[0]}\n`);
    return 1;
  }
  if (candidate === undefined) {
    process.stderr.write(`Run not found: ${ids[1]}\n`);
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify({ baseline, candidate, comparison }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(formatComparison(ids[0], ids[1], comparison!));
  return 0;
}

async function cmdListTasks(tasksDir: string): Promise<number> {
  const ids = await listTasks(tasksDir);
  if (ids.length === 0) {
    process.stdout.write(`No tasks found in ${tasksDir}\n`);
    return 0;
  }
  process.stdout.write(`Tasks in ${tasksDir}:\n`);
  for (const id of ids) {
    try {
      const t = await loadTask(id, tasksDir);
      process.stdout.write(`  ${id}  [${t.category}]  ${t.prompt.split("\n")[0]}\n`);
    } catch (err) {
      process.stdout.write(`  ${id}  (invalid: ${(err as Error).message})\n`);
    }
  }
  return 0;
}

async function cmdCompare(
  store: EvaluationResultStore,
  tasksDir: string,
  args: EvalCliArgs,
  pricing: ReturnType<typeof buildPricingRegistry>,
  requestedIds: string[],
): Promise<number> {
  const providers = args.compare!;
  const runs: EvaluationRun[] = [];
  for (const provider of providers) {
    if (!isProviderName(provider)) {
      process.stderr.write(`Unknown provider: ${provider}\n`);
      return 2;
    }
    const model = args.model ?? DEFAULT_MODELS[provider as ProviderName];
    const apiKey = resolveApiKey(provider);
    if (args.dryRun !== true && apiKey === undefined) {
      process.stderr.write(
        `Missing API key for ${provider}. Set ${API_KEY_ENV[provider as ProviderName]} or use --dry-run.\n`,
      );
      return 1;
    }
    if (!(await confirmCost(provider, model, requestedIds.length, args.dryRun === true, args.yes))) {
      return 1;
    }
    const runner = new EvaluationRunner({
      provider,
      model,
      apiKey,
      tasksDir,
      resultsDir: store.dir,
      pricing,
      maxTurns: args.maxTurns,
      dryRun: args.dryRun,
    });
    const run = await runner.run(requestedIds);
    await store.save(run);
    runs.push(run);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(runs, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(formatComparisonTable(runs));
  return 0;
}

async function cmdRun(
  store: EvaluationResultStore,
  tasksDir: string,
  args: EvalCliArgs,
  pricing: ReturnType<typeof buildPricingRegistry>,
  requestedIds: string[],
): Promise<number> {
  const provider = (args.provider && isProviderName(args.provider) ? args.provider : "openai") as ProviderName;
  const model = args.model ?? DEFAULT_MODELS[provider];
  const apiKey = resolveApiKey(provider);

  if (args.dryRun !== true && apiKey === undefined) {
    process.stderr.write(
      `Missing API key for ${provider}. Set ${API_KEY_ENV[provider]} or use --dry-run.\n`,
    );
    return 1;
  }
  if (!(await confirmCost(provider, model, requestedIds.length, args.dryRun === true, args.yes))) {
    return 1;
  }

  const runner = new EvaluationRunner({
    provider,
    model,
    apiKey,
    tasksDir,
    resultsDir: store.dir,
    pricing,
    maxTurns: args.maxTurns,
    dryRun: args.dryRun,
  });

  const run = await runner.run(requestedIds);
  if (args.dryRun !== true) await store.save(run);

  if (args.json) {
    process.stdout.write(JSON.stringify(run, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(formatRun(run));
  return 0;
}

// ---- helpers --------------------------------------------------------------

function parseArgs(argv: string[]): EvalCliArgs {
  const args: EvalCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--help":
        args.help = true;
        break;
      case "--provider":
        args.provider = next();
        break;
      case "--model":
        args.model = next();
        break;
      case "--tasks-dir":
        args.tasksDir = next();
        break;
      case "--results-dir":
        args.resultsDir = next();
        break;
      case "--max-turns":
        args.maxTurns = Number(next());
        break;
      case "--pricing":
        args.pricing = next();
        break;
      case "--tasks": {
        const v = next();
        args.tasks = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
        break;
      }
      case "--compare": {
        const providers: string[] = [];
        while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
          providers.push(argv[++i]!);
        }
        args.compare = providers;
        break;
      }
      case "--compare-runs": {
        const a1 = next();
        const a2 = next();
        args.compareRuns = [a1, a2];
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--results":
        args.results = true;
        break;
      case "--list-tasks":
        args.listTasks = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--yes":
        args.yes = true;
        break;
      default:
        throw new Error(`Unknown eval flag: ${a}`);
    }
  }
  return args;
}

function resolveTasksDir(override?: string): string {
  if (override !== undefined) {
    return isAbsolute(override) ? override : join(process.cwd(), override);
  }
  return join(process.cwd(), "evals", "tasks");
}

function resolvePricing(spec?: string) {
  if (spec === undefined) return buildPricingRegistry(); // empty ⇒ "unknown"
  if (spec === "default") return buildPricingRegistry("builtin");
  if (existsSync(spec)) {
    const raw = JSON.parse(readFileSync(spec, "utf8"));
    return buildPricingRegistry(raw as Record<string, { inputPerMTok: number; outputPerMTok: number; currency: string }>);
  }
  throw new Error(`--pricing expects "default" or a JSON file path (got "${spec}")`);
}

function resolveApiKey(provider: string): string | undefined {
  return process.env[API_KEY_ENV[provider as ProviderName]];
}

/** Cost-safety gate: warn, then require --yes (or a TTY prompt) for real runs. */
async function confirmCost(
  provider: string,
  model: string,
  taskCount: number,
  dryRun: boolean,
  yes?: boolean,
): Promise<boolean> {
  if (dryRun) {
    // Informational only — go to stderr so a `--json` run stays valid JSON on stdout.
    process.stderr.write(`[dry-run] would run ${taskCount} task(s) on ${provider}/${model} with no API calls.\n`);
    return true;
  }
  process.stderr.write(
    `\n⚠️  Cost check: this will run ${taskCount} task(s) on ${provider}/${model} and call the API.\n` +
      `   Estimated cost is reported only if pricing is configured; otherwise it is "unknown".\n`,
  );
  if (yes) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write("   Re-run with --yes to confirm, or use --dry-run to plan first.\n");
    return false;
  }
  process.stderr.write("   Proceed? [y/N] ");
  const answer = readFileSync(0, "utf8").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// ---- formatting -----------------------------------------------------------

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function formatRun(run: EvaluationRun): string {
  const lines: string[] = [];
  lines.push(`Evaluation run ${run.id}  (${run.provider}/${run.model})`);
  lines.push(
    `  ${run.dryRun ? "dry-run" : "executed"}${run.commitSha ? ` @ ${run.commitSha.slice(0, 9)}` : ""}  pricing: ${run.pricingSource}`,
  );
  lines.push(
    `  success rate: ${pct(run.summary.successRate)}  (${run.summary.passed}/${run.summary.total})`,
  );
  lines.push(`  avg duration: ${Math.round(run.summary.avgDurationMs)} ms`);
  lines.push(
    `  avg LLM turns: ${run.summary.avgLlmTurns.toFixed(1)}   avg tool calls: ${run.summary.avgToolCalls.toFixed(1)}`,
  );
  lines.push(
    `  tokens: in ${run.summary.totalInputTokens} / out ${run.summary.totalOutputTokens} / total ${run.summary.totalTokens}`,
  );
  lines.push(
    `  cost: ${run.summary.totalCost !== undefined ? `${run.summary.totalCost.toFixed(4)} ${run.summary.costCurrency}` : "unknown"}`,
  );
  lines.push("");
  lines.push("Per task:");
  for (const t of run.tasks) {
    lines.push(formatTaskLine(t, "  "));
  }
  return lines.join("\n") + "\n";
}

function formatTaskLine(t: TaskResult, indent: string): string {
  const dur = Math.round(t.durationMs);
  const tokens = t.tokens.totalTokens ?? 0;
  const cost = t.cost.totalCost !== undefined ? ` ~${t.cost.totalCost.toFixed(4)}` : "";
  return `${indent}${t.status.padEnd(7)} ${t.id.padEnd(22)} [${t.category}] ${dur}ms turns:${t.llmTurns} tools:${t.toolCalls} tok:${tokens}${cost}${t.error ? ` — ${t.error}` : ""}`;
}

function formatComparisonTable(runs: EvaluationRun[]): string {
  const header = ["provider/model", "rate", "avg ms", "avg turns", "tok total", "cost"];
  const rows = runs.map((r) => [
    `${r.provider}/${r.model}`,
    pct(r.summary.successRate),
    String(Math.round(r.summary.avgDurationMs)),
    r.summary.avgLlmTurns.toFixed(1),
    String(r.summary.totalTokens),
    r.summary.totalCost !== undefined ? `${r.summary.totalCost.toFixed(4)} ${r.summary.costCurrency}` : "unknown",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const out = ["Comparison:", fmt(header), ...rows.map(fmt)].join("\n");
  return out + "\n";
}

function formatComparison(
  a: string,
  b: string,
  c: NonNullable<Awaited<ReturnType<EvaluationResultStore["compare"]>>["comparison"]>,
): string {
  const lines: string[] = [];
  lines.push(`Comparison: ${a} → ${b}`);
  lines.push(`  success rate: ${pct(c.baseline.successRate)} → ${pct(c.candidate.successRate)} (Δ ${c.successRateDelta >= 0 ? "+" : ""}${c.successRateDelta.toFixed(2)})`);
  lines.push(`  avg duration:  ${Math.round(c.baseline.avgDurationMs)} ms → ${Math.round(c.candidate.avgDurationMs)} ms (Δ ${c.avgDurationMsDelta >= 0 ? "+" : ""}${Math.round(c.avgDurationMsDelta)} ms)`);
  lines.push(`  total tokens:  ${c.baseline.totalTokens} → ${c.candidate.totalTokens} (Δ ${c.totalTokensDelta >= 0 ? "+" : ""}${c.totalTokensDelta})`);
  if (c.totalCostDelta !== undefined) {
    lines.push(`  total cost:    ${c.baseline.totalCost?.toFixed(4)} → ${c.candidate.totalCost?.toFixed(4)} (Δ ${c.totalCostDelta >= 0 ? "+" : ""}${c.totalCostDelta.toFixed(4)})`);
  }
  return lines.join("\n") + "\n";
}
