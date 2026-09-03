# my-agent

A terminal coding agent built from scratch — an LLM that can read, create, edit, and search files and run shell commands in your project, driven by a hand-rolled [Agent Loop](./CONTEXT.md). In the spirit of claude-code / opencode, but with every layer written to be understood.

## Features

- **Hand-rolled agent loop** — stream a response, execute the model's Tool Calls, feed results back, repeat until it answers (`src/agent/chat.ts`)
- **Six core tools** — `read_file`, `write_file`, `edit_file`, `run_bash`, `glob`, `grep` (`src/agent/tools/`)
- **Permission Gate** — every mutating tool call is prompted: `y` once, `n` no, `a` always for this session; `--yolo` skips prompts entirely
- **Two providers, one interface** — OpenAI and Anthropic behind a normalized streaming API (`src/providers/`)
- **JSONL sessions** — full transcripts under `~/.my-agent/sessions/`, resumable with `--continue` / `--session <id>`
- **Context manager** — token-budgeted requests that evict whole Turn Groups so Tool Results never separate from their Tool Calls
- **Ink TUI** — streamed tokens, live tool activity, permission prompts, markdown-lite rendering, styled as 水墨 monochrome ink-wash: hierarchy through brush density, one vermilion seal accent

## Getting started

```bash
npm install
echo 'OPENAI_API_KEY=sk-...' > .env.local   # or ANTHROPIC_API_KEY
npm run dev
```

Useful flags:

```bash
npm run dev -- --provider anthropic   # switch provider (default openai)
npm run dev -- --model gpt-4o         # override model (or MY_AGENT_MODEL)
npm run dev -- --continue             # resume most recent session
npm run dev -- --yolo                 # auto-approve mutating tools
```

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
npm test             # vitest: loop wiring, tools, gates, sessions, context, provider mappings, skills
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
│   ├── provider.ts      Provider seam: stream(messages) → StreamEvent
│   ├── openai.ts        chat.completions streaming + tool-call accumulation
│   └── anthropic.ts     messages streaming + content-block assembly
├── permissions/gate.ts  AskUserGate (session allowlist), AutoApproveGate
├── context/manager.ts   budget estimation + group-wise eviction
├── session/store.ts     append-only JSONL persistence
└── ui/                  Ink app, permission prompts, markdown-lite
```

Domain vocabulary lives in [CONTEXT.md](./CONTEXT.md); decisions in [docs/adr/](./docs/adr/).

