# my-agent

A terminal coding agent built from scratch — an LLM that can read, create, edit, and search files and run shell commands in your project, driven by a hand-rolled [Agent Loop](./CONTEXT.md). In the spirit of claude-code / opencode, but with every layer written to be understood.

## Features

- **Hand-rolled agent loop** — stream a response, execute the model's Tool Calls, feed results back, repeat until it answers (`src/agent/chat.ts`)
- **Six core tools** — `read_file`, `write_file`, `edit_file`, `run_bash`, `glob`, `grep` (`src/agent/tools/`)
- **Permission Gate** — every mutating tool call is prompted: `y` once, `n` no, `a` always for this session; `--yolo` skips prompts entirely
- **Four providers, one interface** — OpenAI, Anthropic, Google Gemini and Zhipu GLM behind a normalized streaming API (`src/providers/`)
- **JSONL sessions** — full transcripts under `~/.my-agent/sessions/`, resumable with `--continue` / `--session <id>`
- **Context manager** — token-budgeted requests that evict whole Turn Groups so Tool Results never separate from their Tool Calls
- **Ink TUI** — streamed tokens, live tool activity, permission prompts, markdown-lite rendering, terminal-native styling: monochrome with a single cyan accent

## Getting started

```bash
npm install
echo 'OPENAI_API_KEY=sk-...' > .env.local   # or ANTHROPIC_API_KEY / GEMINI_API_KEY / GLM_API_KEY
npm run dev
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
├── permissions/gate.ts  AskUserGate (session allowlist), AutoApproveGate
├── context/manager.ts   budget estimation + group-wise eviction
├── session/store.ts     append-only JSONL persistence
└── ui/                  Ink app, permission prompts, markdown-lite
```

Domain vocabulary lives in [CONTEXT.md](./CONTEXT.md); decisions in [docs/adr/](./docs/adr/).

