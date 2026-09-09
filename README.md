# my-agent

A terminal coding agent built from scratch — an LLM that can read, create, edit, and search files and run shell commands in your project, driven by a hand-rolled [Agent Loop](./CONTEXT.md). In the spirit of claude-code / opencode, but with every layer written to be understood.

## Features

- **Hand-rolled agent loop** — stream a response, execute the model's Tool Calls, feed results back, repeat until it answers (`src/agent/chat.ts`)
- **Six core tools** — `read_file`, `write_file`, `edit_file`, `run_bash`, `glob`, `grep` (`src/agent/tools/`)
- **Permission Gate** — every mutating tool call is prompted: `y` once, `n` no, `a` always for this session; `--yolo` skips prompts entirely
- **Four providers, one interface** — OpenAI, Anthropic, Google Gemini and Zhipu GLM behind a normalized streaming API (`src/providers/`)
- **Sub-Agents and orchestration** — the main agent delegates a single task via `delegate_to_agent`, or runs a DAG of tasks in parallel via `orchestrate_tasks`; each child runs the same loop with its own context, tool allowlist and optionally its own model (`src/subagent/`, `src/orchestration/`)
- **JSONL sessions** — full transcripts under `~/.my-agent/sessions/`, resumable with `--continue` / `--session <id>`
- **Context manager** — token-budgeted requests that evict whole Turn Groups so Tool Results never separate from their Tool Calls
- **Ink TUI** — streamed tokens, live tool activity, permission prompts, markdown-lite rendering, terminal-native styling: monochrome with a single cyan accent

## Getting started

```bash
npm install
npm run dev
```

Then configure a provider from inside the app — no file editing needed:

```text
> /provider
```

Pick a provider, paste your key (input is masked), choose a model. It is stored
under `~/.my-agent/` and reused on later runs. See
[Provider & model setup](#provider--model-setup).

The old environment-variable route still works if you prefer it:

```bash
export OPENAI_API_KEY=...   # or ANTHROPIC_API_KEY / GEMINI_API_KEY / GLM_API_KEY
```

Useful flags:

```bash
npm run dev -- --provider gemini     # openai | anthropic | gemini | glm (default openai)
npm run dev -- --model gpt-4o         # override model (or MY_AGENT_MODEL)
npm run dev -- --continue             # resume most recent session
npm run dev -- --yolo                 # auto-approve mutating tools
```

## Providers

All four providers sit behind one `Provider` seam (`src/providers/provider.ts`).
The Agent and AgentHarness only ever see normalized messages, tools and stream
events — the only place a provider is chosen is `createProvider`.

| Provider  | Env var             | Default model       | Streaming | Tool calling |
|-----------|---------------------|---------------------|-----------|--------------|
| openai    | `OPENAI_API_KEY`    | `gpt-4o-mini`       | Yes       | Yes          |
| anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` | Yes       | Yes          |
| gemini    | `GEMINI_API_KEY`    | `gemini-2.5-flash`  | Yes       | Yes          |
| glm       | `GLM_API_KEY`       | `glm-4.6`           | Yes       | Yes          |

Switch with `--provider`, or set `MY_AGENT_PROVIDER` / `MY_AGENT_MODEL`:

```bash
npm run dev -- --provider gemini --model gemini-2.5-pro
npm run dev -- --provider glm
```

Keys are read from the environment or `.env.local` / `.env`; they are never
stored in source. Capabilities above are the ones covered by unit tests using
mocked clients, so the suite needs no live API access.

### Provider notes

- **Gemini** uses the official `@google/genai` SDK. System text maps to
  `systemInstruction`, Tool Results to `functionResponse` parts, and JSON-Schema
  tool parameters are converted to Gemini's uppercase `Schema` enums.
- **GLM** (Zhipu AI) is served through its OpenAI-compatible endpoint, so it
  reuses the same request/stream translation against a different base URL. Set
  `GLM_BASE_URL` to target a gateway or self-hosted deployment.
- Adding a fifth provider means adding one case to `createProvider`; the
  switch is exhaustive, so the compiler flags any missing branch. The Agent
  loop, Harness, TUI and tools require no changes.

## Provider & model setup

You never need to open `.env.local`. Everything below is done from the TUI.

```text
> /provider

Select Provider
  OpenAI
  Gemini
  GLM

Gemini is not configured.

Enter Gemini API key:
> ••••••••••••

✓ Gemini configured

Select model — Gemini
> Gemini 2.5 Flash
  Gemini 2.5 Pro

✓ Active: Gemini / gemini-2.5-flash
```

### Commands

| Command | What it does |
|---|---|
| `/provider` | list providers with their configuration state |
| `/provider <id>` | configure, or open the options menu if already configured |
| `/provider remove <id>` | delete the stored credential |
| `/model` | pick a model for the active provider |
| `/model <id>` | switch directly |

When a provider is already configured, `/provider <id>` offers: use current
configuration, change API key, select model, remove configuration, cancel. It
never re-asks for a key that already works. `Esc` cancels at any step; a
cancelled setup changes nothing.

These commands are handled locally. They are never sent to the model — verified
by `npm run smoke:tui`.

### Where things live

```text
~/.my-agent/
    credentials.json   API keys — owner-only permissions where supported
    config.json        active provider + model (ids only, safe to print)
    sessions/          conversation history
```

Credentials, provider metadata and the runtime selection are three separate
things:

```text
CredentialStore  →  ProviderRegistry  →  ProviderManager  →  ModelManager
     (secret)         (what exists)        (is it ready)      (which model)
```

Sessions store only `provider` and `model`. They never contain an API key, and
neither does memory, context, tool results or the observability stream.

### Environment variables are legacy

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `GLM_API_KEY` still
work as a bootstrap source: if no stored credential exists, the environment is
consulted and the provider counts as configured. The application never writes
to `.env.local`. `/provider <id>` can import an environment key into the store.

The app now also boots with nothing configured, so `/provider` is reachable —
previously a missing key aborted startup.

### Runs use an immutable snapshot

Each run captures its provider and model when it starts. Switching with
`/provider` or `/model` mid-run does not retarget the request in flight; the
change applies from the next run. Sub-agents and parallel tasks inherit that
snapshot unless they explicitly name a provider or model, and a sub-agent that
asks for an unconfigured provider is refused rather than prompted.

### Security notes and limitations

- Credentials live outside any workspace, so the filesystem boundary refuses
  them without a special case, and `cat`/`type` on a path outside the workspace
  is blocked.
- The key input is masked and is never echoed, logged, or written to a session.
- **Credential validation is local (non-empty) only.** There is no network
  round-trip during setup, so a wrong key surfaces on the first request. The
  validator is injectable if real validation is wanted later.
- **This is not OS-level isolation.** Commands run as your user. The security
  layer is an application-level policy boundary.
- File permissions are enforced on POSIX-like systems. On Windows, `chmod` is
  advisory and the file is created with default ACLs — the limitation is real
  and not papered over.

In the TUI: `/help` shows commands, `/exit` quits, `/skills` lists available skills.

## Skills

Skills define *how* the agent should approach a class of tasks. They are behavioral instructions, not executable tools.

```
Agent
├── Skills → behavioral/instructional capability (debugging, TDD, code review …)
└── Tools  → execution capability (read_file, write_file, bash, MCP tools …)
```

### Skills vs Tools vs MCP

| Concern | What it provides | Example |
|---------|-----------------|---------|
| **Tools** | What the agent *can do* | `read_file`, `write_file`, `run_bash` |
| **MCP** | External tools from MCP servers | `mcp.github.search_code` |
| **Skills** | How the agent *should think* | TDD, code review, research |

Skills never bypass the permission gate. If a skill instructs the agent to use `run_bash`, the permission check still applies.

### SKILL.md format

Skills follow the [mattpocock/skills](https://github.com/mattpocock/skills) convention:

```
skills/<skill-name>/SKILL.md
```

A `SKILL.md` file has YAML frontmatter and a Markdown body:

```markdown
---
name: tdd
description: Test-driven development. Red-green-refactor.
---

# Test-Driven Development

Write the test first. Watch it fail. Make it pass. Refactor.
…
```

**Frontmatter fields:**
- `name` (required) — skill identifier
- `description` (required) — one-line summary (shown to the model for discovery)
- `disable-model-invocation: true` — makes the skill user-invoked only (default: model can select it)
- `argument-hint` — TUI hint for skills that accept an argument

### User-invoked vs model-invoked skills

**User-invoked** (`disable-model-invocation: true`): explicitly triggered via a slash command.

```
/implement fix the parser
/grill-me about the migration plan
/tdd
```

**Model-invoked** (no `disable-model-invocation`): the model sees lightweight metadata in the system prompt and can load the skill when relevant.

### CLI usage

```
/skills              list all available skills
/tdd                 invoke the tdd skill
/implement fix auth  invoke implement with context
```

### Skill directories

Skills are discovered from two directories (in order):

1. `.agents/skills/` — project-specific or installed skills
2. `skills/` — local skills

### External skills

Install external skill repositories (e.g. [mattpocock/skills](https://github.com/mattpocock/skills)) into `.agents/skills/`:

```bash
npx skills@latest add mattpocock/skills
```

Or manually copy skill directories into `.agents/skills/`. The agent will discover them on startup.

## Sub-Agents

A Sub-Agent is an independent agent execution the parent delegates to. The
parent decides *when* that is useful — delegation is an ordinary tool call:

```text
User → Main Agent → delegate_to_agent → SubAgentManager → Sub-Agent → Result
```

The parent receives a concise structured result (status, summary, tools used,
files changed, errors) and never the child's transcript. Sub-Agents run the
same `AgentRuntime` as the parent; nothing about the loop is duplicated.

### Roles

| Role                | Tools                                  | Purpose                     |
|---------------------|----------------------------------------|-----------------------------|
| `general`           | all six                                | default, full access        |
| `researcher`        | `read_file`, `glob`, `grep`            | investigate, read-only      |
| `coder`             | all six                                | implement changes           |
| `reviewer`          | `read_file`, `glob`, `grep`            | review, read-only           |
| `debugger`          | `read_file`, `glob`, `grep`, `run_bash`| diagnose                    |
| `planner`           | `read_file`, `glob`, `grep`            | plan, read-only             |
| `security-reviewer` | `read_file`, `glob`, `grep`            | security audit, read-only   |

A role only selects system instructions, a tool allowlist and skills — it adds
no branching behaviour.

### Provider selection

A Sub-Agent may use a different model from its parent:

```json
{
  "task": "Audit the authentication flow for security issues",
  "role": "security-reviewer",
  "provider": "gemini",
  "model": "gemini-2.5-pro"
}
```

Omit `provider`/`model` and the child inherits the parent's. Resolution goes
through the same `createProvider` factory, so there is no provider-specific
logic in the manager.

### Isolation and limits

- **Context** — the child sees only the task plus what the parent explicitly
  hands over (`relevantContext`, `files`, `constraints`). The parent
  conversation is never copied in.
- **Sessions** — children are not persisted, and their transcripts never merge
  into the parent's session.
- **Memory** — children do not write persistent memories.
- **Permissions** — children use the parent's Permission Gate, so a mutating
  call is still prompted; read-only roles cannot reach write tools at all.
- **Limits** — `maxTurns` (default 10), `timeoutMs` (default 120s),
  `maxSubAgentDepth` (default 1, so sub-agents cannot spawn further
  sub-agents), plus parent cancellation via `AbortSignal`.

A failed, timed-out or cancelled Sub-Agent returns a structured result; it
never takes the parent down.

### Current limitations

- Sub-Agents run **one at a time**; the manager is shaped for parallel
  execution later, but nothing runs concurrently yet.
- Nested delegation is disabled by default (`maxSubAgentDepth = 1`).
- Sub-Agents do not write long-term memory.

## Task Orchestration

`orchestrate_tasks` runs a **DAG of tasks** as Sub-Agents. Independent tasks
execute in parallel; tasks with dependencies wait for them.

```text
             ┌── Task A ──┐
             │            │
Main Agent ──┼── Task B ──┼──→ Task D ──→ Aggregated Result
             │            │
             └── Task C ──┘
```

The orchestrator owns *only* orchestration — validation, readiness,
concurrency, retries, cancellation and aggregation. Every task is executed
through the same `SubAgentManager`, so provider creation, context building,
tool execution, permissions and timeouts all have exactly one implementation.

```json
{
  "tasks": [
    { "id": "auth",   "task": "Analyze authentication",        "role": "security-reviewer" },
    { "id": "deps",   "task": "Analyze dependencies",          "role": "security-reviewer" },
    { "id": "review", "task": "Consolidate the findings",      "role": "reviewer", "dependencies": ["auth", "deps"] }
  ],
  "maxConcurrency": 3
}
```

### Semantics

| Concern        | Behaviour                                                                 |
|----------------|---------------------------------------------------------------------------|
| Validation     | Plan checked before anything runs: duplicate ids, unknown/self deps, cycles |
| Concurrency    | `maxConcurrency` (default 3, hard cap 8); never unbounded                  |
| Dependencies   | A task starts only once every dependency has *completed*                   |
| Failure        | `continue` (default) keeps independent tasks running; `fail-fast` stops     |
| Broken deps    | Dependent task is **skipped**, with the reason recorded                     |
| Retries        | `maxRetries` for transient failures only (rate limit, timeout, 5xx); never for permission or config errors. Exponential backoff, capped at 8s |
| Timeouts       | Plan timeout wraps per-task timeouts; expiry stops scheduling and cancels   |
| Cancellation   | One `AbortSignal` chain: caller → orchestrator → SubAgentManager → child    |
| Aggregation    | Concise per-task digest (status + one-line summary); no raw transcripts     |

### Isolation

Each task is a separate Sub-Agent with its own context. A dependent task
receives only **selected** results from its dependencies (summaries,
findings, changed files) — never their transcripts, and never its siblings'
context. `orchestrate_tasks` and `delegate_to_agent` are both withheld from
children, so a sub-agent cannot fan out its own plan.

### Current limitations

- In-process only; no distributed workers or external queues.
- Results are aggregated structurally — there is no "aggregator agent".
- Provider-level capacity limits (per-provider concurrency) are not yet
  modelled; only the global `maxConcurrency` applies.

## Observability & Reliability

Every run is reconstructable from structured data — no console spelunking.

```text
run_01J...
├── main-agent  (Run ID, provider, model, turns, duration)
│   ├── llm.request.*   (duration, tokens)
│   └── tool.*          (name, duration, permission result)
│
└── orchestration
    ├── task A → sub-agent → llm + tools
    └── task B → sub-agent → llm + tools
```

### Execution identity

`src/observability/ids.ts` mints UUID-based IDs (`run_…`, `exec_…`, `span_…`) —
never bare timestamps, which would collide between parallel sub-agents. Every
event carries `runId`, `executionId` and `parentExecutionId`, so the tree
stays queryable and OpenTelemetry can be added later without reworking it.

### Events, logs, metrics, traces

| Layer    | Where                          | Notes |
|----------|--------------------------------|-------|
| Events   | `observability/events.ts`, `bus.ts` | Dotted taxonomy (`llm.request.completed`, `task.retrying`, …). Emitted without knowledge of consumers |
| Logging  | `observability/logger.ts`      | `debug`/`info`/`warn`/`error`; `--debug` for verbose, `--json`-style output available programmatically |
| Metrics  | `observability/metrics.ts`     | In-process counters/observations/gauges: `agent_runs_*`, `llm_request_duration_ms`, `llm_input_tokens`, `tool_calls_*`, `subagent_*`, `tasks_*`, `retries_total`, `timeouts_total`, `cancellations_total` |
| Tracing  | `observability/trace.ts`       | Spans with `spanId`/`parentSpanId` and **monotonic** timing, so a clock change cannot corrupt durations |

The new taxonomy is **additive**: the TUI's existing hyphenated `AgentEvent`
(`tool-start`, …) is untouched.

### Error classification and retry

`classifyError()` normalizes anything thrown into an `AgentError` with a
`kind` (`rate_limit`, `network`, `model_unavailable`, `timeout`,
`authentication`, `permission`, `invalid_request`, `tool`, `configuration`,
`context`, `cancellation`, `internal`) and a retryability verdict — so retry
decisions no longer depend on string matching at the call site.

Retryable: rate limits, network errors, timeouts, temporary provider
unavailability. Never retried: auth failures, invalid requests, permission
denials, bad configuration.

Backoff is bounded (`1s → 8s`) with jitter, lives in one place
(`observability/retry.ts`), and the orchestrator now delegates to it — there
is no second retry implementation. Waiting respects `AbortSignal`, so
cancellation interrupts a retry immediately.

### Timeout and cancellation precedence

```text
run timeout  →  task timeout  →  sub-agent timeout  →  llm request
```

One `AbortSignal` chain: caller → AgentHarness → TaskOrchestrator →
SubAgentManager → child → provider/tools. Cancelling stops scheduling, aborts
in-flight requests, marks pending work cancelled, and emits events.

### Tokens and cost

`TokenUsage` normalizes vendor usage into one shape. **Pricing is not
invented**: the default pricing table is empty, so cost is reported as
`unknown` rather than guessed. Register real pricing to get numbers:

```ts
pricing.register("gpt-4o", { inputPerMTok: 5, outputPerMTok: 15, currency: "USD" });
```

### Security

Logging is safe by default. Forbidden keys (`apiKey`, `authorization`,
`token`, `password`, …) are replaced with `[redacted]`, and every other string
passes through the existing `redactSecrets` from `src/memory/sanitize.ts` —
the same sanitizer that guards memory writes. Tool output and prompts are
never logged wholesale.

### Deferred

- **Circuit breaker** — not implemented. The current failure surface is a
  single process with per-request retries; a breaker would add state and
  failure modes without clear benefit here. The provider seam makes it
  straightforward to add if provider-level failure isolation is needed.
- External metrics/tracing backends, persistent observability storage.

## Security

The model is not trusted. It may *request* an operation; the security layer
decides whether it happens. Every tool call — main agent, sub-agent, and MCP —
is authorized by a single `SecurityManager` before the permission gate runs.

> **What this is not.** This is an application-level policy boundary, not
> OS-level isolation. A command that policy allows still runs as your user with
> your privileges. It is not a container, sandbox, or VM. See "Limitations".

### Modes

`--security-mode <restricted|workspace|permissive>` (or `MY_AGENT_SECURITY_MODE`).
Default: `workspace`.

| Mode | Files | Shell | MCP | Notes |
|---|---|---|---|---|
| `restricted` | read/write in workspace | **no** `process.execute` | not granted | no shell at all |
| `workspace` | read/write, delete gated | allowed, dangerous blocked | per-tool allowlist | normal coding-agent mode |
| `permissive` | adds delete | adds network; dangerous still asks | per-tool allowlist | not "off" — see below |

`permissive` removes friction, never the boundary. Audit logging, secret
redaction, path normalization, resource limits, cancellation and timeouts all
remain active. An unrecognised mode is a startup error, not a fallback.

### Capabilities

Authority is expressed as composable capabilities (`filesystem.read`,
`filesystem.write`, `filesystem.delete`, `process.execute`, `process.network`,
`environment.read`, `mcp.use`, `agent.spawn`, …) rather than booleans.

A child receives the **intersection** of what it asks for and what its parent
holds. Requesting something the parent lacks is ineffective and is recorded as
a `security.policy_violation`. `agent.escalate` is never granted at any mode,
and there is no `disable()` / `allowAll()` / `bypass()` API.

### Filesystem boundary

Resolution order: normalize → resolve → check containment → resolve symlinks →
check containment again → sensitive-file policy → capability check.

- Containment uses `path.relative`, never a string prefix (`/project` must not
  contain `/project-secret`).
- Blocks: `../` traversal, absolute outside paths, other drives, UNC paths,
  encoded traversal (`%2e%2e%2f`), null bytes.
- Symlinks and junctions are resolved and re-checked; one that escapes the
  workspace is refused. A link that stays inside is harmless and allowed.
- Sensitive paths (`.env`, `*.pem`, `id_rsa`, `service-account.json`, `.npmrc`,
  `.aws/credentials`, `secrets.*`, …) are denied for read, and denied for write.
- `.git` internals are readable (git needs them) but not writable via tools.

The workspace root's own symlink resolution is cached and treated as a valid
root. Without that, a root behind a link (OneDrive, macOS `/tmp`, a junctioned
checkout) would make every path look like an escape and deny the whole project.

### Command policy

The whole command is analyzed, not just its first token — `echo ok && rm -rf /`
inherits `rm`'s classification, not `echo`'s. Chaining (`;`, `&&`, `||`, `|`),
redirection, and substitution (`$(...)`, backticks) are split into segments and
the verdict is the worst segment.

| Class | Examples | Result |
|---|---|---|
| safe | `git status`, `npm test`, `ls`, `tsc --noEmit` | allowed |
| caution | `npm install`, `git checkout`, unknown commands | allowed, confirmation |
| dangerous | `rm`, `kill`, `chmod`, `git reset --hard` | refused |
| forbidden | `rm -rf /`, `curl … \| sh`, `Invoke-Expression`, `git push --force` | refused |

An unrecognised command is `caution`, never `safe`. The working directory must
be inside the workspace.

### Environment, secrets, and redaction

Child processes receive a **filtered** environment: secret-shaped variables
(`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `AWS_*`, `OPENAI_*`,
`DATABASE_URL`, …) are removed, and remaining values pass through the existing
`redactSecrets`. `process.env` is never handed to the model. Security reuses
that one redactor — there is no second implementation.

### MCP and sub-agents

MCP tools are untrusted by default: an unknown tool is denied until
allowlisted, and servers can be restricted. Sub-agents inherit a narrowed
context; tasks may declare `capabilities`, which are still intersected with the
orchestrator's. A blocked sub-agent operation is reported through the audit
stream with the agent's label.

### Permissions and `--yolo`

Security runs **before** the permission gate, so a policy denial cannot be
approved away — not by a user, and not by `--yolo`.

```text
security deny   > user approval
```

`--yolo` skips interactive confirmation for operations policy already allows.
It does not relax path traversal protection, forbidden commands, secret
protection, capability boundaries, or sandbox restrictions.

### Resource limits

Configured per policy: `maxCommandDurationMs`, `maxOutputBytes`,
`maxFileReadBytes`, `maxFileWriteBytes`, `maxConcurrentProcesses`. Oversized
output is truncated with an explicit `[… truncated at N chars]` marker and a
`security.output_truncated` event. Timeouts reuse the existing reliability
layer — no competing timers.

### Audit

Security decisions emit structured events on the existing bus
(`security.allowed`, `security.denied`, `security.path_blocked`,
`security.command_blocked`, `security.secret_access_blocked`,
`security.policy_violation`, `security.output_truncated`), each carrying
`runId`, `executionId`, `parentExecutionId`, decision, risk and reason — never
raw secrets. Counters land in the same in-process metrics collector:
`security_checks_total`, `security_denials_total`,
`dangerous_commands_blocked_total`, `path_traversals_blocked_total`,
`secret_access_blocked_total`.

### Limitations

- Application-level policy only. No kernel, container, or VM isolation.
- Command classification is pattern-based and deliberately conservative; it
  aims to prevent obvious bypasses and fail closed, not to parse shell
  perfectly.
- Secret detection is pattern-based and not exhaustive. The posture is
  safe-by-default (withhold, don't guess), not perfect detection.
- Real OS-level sandboxing (Docker, WASM, VM) is deferred. The extension point
  is `SecurityManager`: a future `ExecutionSandbox` implementation would sit
  behind the same authorization call, so tools would not change.

## Verification

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest: loop wiring, tools, gates, sessions, context, provider mappings + streaming, skills
npm run smoke:openai # headless streamed completion
npm run smoke:agent  # headless multi-tool agent task with disk verification
```

## Architecture

```
src/
├── index.tsx            CLI entry: flags → config → providers → skills → UI
├── agent/
│   ├── chat.ts          ChatService: history + the Agent Loop + tool execution
│   ├── registry.ts      ToolRegistry: zod schemas → JSON Schema, validation
│   ├── tool.ts          Tool contract (+ ruleKey for allowlisting)
│   ├── types.ts         ChatMessage / AssistantMessage / ToolCallRequest
│   └── tools/           the six tools + shared tree walker + glob matcher
├── harness/
│   ├── harness.ts       AgentHarness: lifecycle, sessions, skills, MCP
│   ├── runtime.ts       AgentRuntime: the agent/tool loop
│   ├── events.ts        Streaming event types
│   └── state.ts         Run state machine
├── skills/
│   ├── loader.ts        SKILL.md parser + directory discovery
│   ├── registry.ts      SkillRegistry: metadata-first skill namespace
│   ├── resolver.ts      SkillResolver: name resolution + depth guard
│   └── index.ts         Barrel export
├── mcp/
│   ├── config.ts        MCP server configuration + .my-agent.json loader
│   ├── client.ts        McpClient: SDK wrapper for stdio transport
│   ├── adapter.ts       MCP tool → ToolDefinition adapter
│   ├── manager.ts       McpManager: multi-server lifecycle
│   └── index.ts         Barrel export
├── providers/
│   ├── provider.ts        Provider seam: stream(messages) → StreamEvent
│   ├── create-provider.ts Factory: config → Provider (exhaustive switch)
│   ├── openai.ts          chat.completions streaming + tool-call accumulation
│   ├── anthropic.ts       messages streaming + content-block assembly
│   ├── anthropic-mapping.ts
│   ├── gemini.ts          @google/genai streaming
│   ├── gemini-mapping.ts  systemInstruction, functionCall/Response, schema enums
│   └── glm.ts             Zhipu GLM via its OpenAI-compatible endpoint
├── subagent/
│   ├── manager.ts       SubAgentManager: lifecycle, limits, cancellation
│   ├── roles.ts         role presets → system prompt + tool allowlist
│   └── types.ts         SubAgentSpec / SubAgentResult / SubAgentContext
├── orchestration/
│   ├── orchestrator.ts  TaskOrchestrator: DAG scheduling, concurrency, retries
│   ├── graph.ts         plan validation + cycle detection
│   └── types.ts         AgentTask / TaskResult / OrchestrationResult
├── permissions/gate.ts  AskUserGate (session allowlist), AutoApproveGate
├── context/manager.ts   budget estimation + group-wise eviction
├── session/store.ts     append-only JSONL persistence
└── ui/                  Ink app, permission prompts, markdown-lite
```

Domain vocabulary lives in [CONTEXT.md](./CONTEXT.md); decisions in [docs/adr/](./docs/adr/).

