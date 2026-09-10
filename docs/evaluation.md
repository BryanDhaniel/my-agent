# Evaluation & Benchmarking

A lightweight, production-minded, **provider-agnostic** evaluation system for `my-agent`.

It drives the **real `AgentHarness`** — there is no second, parallel agent implementation
to keep in sync. Curated tasks are run end-to-end through the same headless execution
surface the TUI uses, so benchmarks measure the agent you actually ship.

## What it answers

- **Success rate** — what fraction of tasks pass their validation gate.
- **Tokens / task** — provider-authoritative usage, or `"unknown"` when the provider
  doesn't report it (never guessed).
- **Duration, LLM turns, tool calls** — per task and averaged.
- **Estimated cost** — only when a pricing table is supplied; otherwise `"unknown"`.
- **Provider comparison** — OpenAI vs Gemini vs others on the same task set.
- **Regression detection** — compare two stored runs across commits.

## Design principles

- **Real harness, no twins.** `EvaluationRunner` constructs `AgentHarness.create(...)`
  and iterates `harness.run(prompt, signal)`. The only injected doubles are the
  `Provider` (a `FakeProvider` in tests) and the pricing/observability sinks.
- **No real API calls in `npm test`.** `FakeProvider` follows a scripted plan and emits
  provider-authoritative `usage` on its final event, so the full eval suite runs offline.
- **No secrets, no leaks.** Results are stored under `~/.my-agent/evaluations/` and contain
  only metrics (status, tokens, cost, durations). Task fixtures and prompts carry no secrets.
- **Conservative defaults.** Tasks run **sequentially**, there is **no auto-repeat**, and a
  per-task **turn cap** (via `AbortController`) stops a stuck task from running forever or
  racking up cost. The runner's safety cap is authoritative: an explicit `--max-turns` (or
  the runner default) is *not* widened by a per-task `maxTurns` override.
- **Provider-agnostic costing.** Cost is opt-in. Without a pricing table every cost is
  `"unknown"`. With one, it is labelled *estimated* — these are example prices, not a
  billing system.
- **Isolated fixtures.** Each task gets a fresh copy of its fixture in a temp dir; security
  is scoped to that dir in `workspace` mode. Fixtures are cleaned up after each run.

## CLI

```
my-agent eval [options]

  --provider <name>      Provider to run (openai|anthropic|gemini|glm).
  --model <id>           Model id (defaults to the provider default).
  --compare <p...>       Run the same task set across several providers; prints a comparison.
  --tasks <id,id>        Run only these task ids (default: all discovered).
  --tasks-dir <path>     Task dataset directory (default: ./evals/tasks).
  --results-dir <path>   Where runs are stored (default: ~/.my-agent/evaluations).
  --dry-run              Plan the run; make NO API calls.
  --results              List previously stored runs (no API calls).
  --compare-runs <a> <b> Compare two stored runs (no API calls).
  --list-tasks           List available task ids (no API calls).
  --pricing <default|file.json>  Enable estimated cost ("unknown" by default).
  --max-turns <n>        Per-task turn cap (default: 25).
  --json                 Emit JSON instead of a formatted report.
  --yes                  Skip the cost-safety confirmation for real runs.
  --help                 Show help.
```

### Examples

```bash
# Plan a run with zero API calls (verifies tasks, wiring, turn caps):
my-agent eval --dry-run --json

# Execute the curated suite on OpenAI, with estimated cost:
my-agent eval --provider openai --pricing default

# Run only two tasks:
my-agent eval --provider openai --tasks fix-off-by-one,add-clamp

# Compare providers on the same task set:
my-agent eval --compare openai gemini --pricing default

# Inspect previous runs without calling any API:
my-agent eval --results
my-agent eval --compare-runs <runIdA> <runIdB>

# List the curated tasks:
my-agent eval --list-tasks
```

## Curated tasks

Tasks live under `evals/tasks/<id>/`:

```
evals/tasks/fix-off-by-one/
  task.json            # id, category, prompt, validation, optional maxTurns
  fixture/             # isolated project the agent operates on
    package.json
    src/sum.mjs
    test/sum.test.mjs  # node --test; exit 0 == pass
```

`task.json` shape:

```json
{
  "id": "fix-off-by-one",
  "category": "bug-fix",
  "prompt": "The sum function has an off-by-one error; fix it so the tests pass.",
  "fixture": "fixture",
  "maxTurns": 8,
  "validation": { "command": "node --test", "timeoutMs": 20000 }
}
```

- **category**: one of `bug-fix | feature | refactor | testing | debugging` (used for the
  per-category breakdown).
- **validation.command**: run from inside the fixture (or `validation.cwd` relative to it).
  Exit code 0 ⇒ pass. This is the ground truth — a task is `passed` only when validation
  succeeds; an agent that *claims* success but fails validation is `failed`.
- **maxTurns**: optional per-task cap; never raises the runner's safety cap.

The current dataset spans all five categories with deterministic, isolated fixtures.
Each fixture is verified to **fail before a fix** and **pass after a correct fix**.

### Status values

| status    | meaning                                                            |
|-----------|-------------------------------------------------------------------|
| `passed`  | agent ran and validation exited 0                                  |
| `failed`  | validation failed, the agent errored mid-run, or the stream errored |
| `error`   | an unexpected exception thrown by the harness itself (e.g. fixture setup) |
| `timeout` | the turn cap was hit / the run was cancelled                       |
| `skipped` | dry-run: no execution, no API calls                               |

## Adding a task

1. Create `evals/tasks/<id>/task.json` (use an existing task as a template).
2. Add a `fixture/` with a small, deterministic project and a `node --test` (or other
   `validation.command`) that currently **fails**.
3. Confirm: `node --test` in the fixture fails, then a correct edit makes it pass.
4. Verify the dataset loads: `my-agent eval --list-tasks`.
5. Run offline end-to-end with the fake provider in `npm test` (the eval unit tests
   exercise the runner through `FakeProvider` — no API key required).

Keep fixtures isolated and side-effect free; the runner copies them per run and deletes
the copy afterwards.

## Cost & pricing

Cost is **opt-in and estimated**. By default the pricing registry is empty, so every task
reports `cost: { currency: "unknown" }`. Pass `--pricing default` for a built-in table of
example USD prices, or `--pricing path/to/prices.json` for your own:

```json
{ "gpt-4o-mini": { "inputPerMTok": 0.15, "outputPerMTok": 0.6, "currency": "USD" } }
```

Pricing matches by exact model id, then by longest prefix (e.g. `"gpt-4o"` matches
`"gpt-4o-2024-08-06"`). A model with no entry always yields `"unknown"` — we never invent
prices.

## Results & regression detection

Every executed run is saved to `~/.my-agent/evaluations/` as JSON containing only metrics.
Inspect them without any API call:

- `my-agent eval --results` — newest runs first, with pass counts and commit SHAs.
- `my-agent eval --compare-runs <a> <b>` — success-rate, duration, token and cost deltas,
  so you can catch regressions between commits (`EvaluationRunner` records `commitSha` from
  `git rev-parse HEAD` when available).

## Architecture

```
src/eval/
  types.ts          domain types (tasks, results, run, options)
  pricing.ts        configurable, opt-in PricingRegistry (BUILTIN_PRICING)
  metrics.ts        summarize, categoryBreakdown, compareRuns
  task-loader.ts    list/load tasks from disk (explicit, no zod)
  fixture-manager.ts prepareFixture (temp copy) + cleanup
  validator.ts      runValidation (spawns command, resolves on exit, kills on timeout)
  result-store.ts   save/load/list/compare under ~/.my-agent/evaluations/
  runner.ts         EvaluationRunner — drives the REAL AgentHarness
  cli.ts            `my-agent eval` subcommand + cost-safety gate
  index.ts          barrel
  test/             FakeProvider + unit/integration tests (all offline)
```

The runner subscribes to the harness observability bus to capture provider-authoritative
token usage per run, and reads cost from the (possibly empty) pricing registry. A turn cap
aborts the run and marks it `timeout`; validation is skipped for any non-`passed` outcome so
a failed run is never mislabeled as passing.
