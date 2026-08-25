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

In the TUI: `/help` shows commands, `/exit` quits.

## Verification

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest: loop wiring, tools, gates, sessions, context, provider mappings
npm run smoke:openai # headless streamed completion
npm run smoke:agent  # headless multi-tool agent task with disk verification
```

## Architecture

```
src/
├── index.tsx            CLI entry: flags → config → providers → UI
├── agent/
│   ├── chat.ts          ChatService: history + the Agent Loop + tool execution
│   ├── registry.ts      ToolRegistry: zod schemas → JSON Schema, validation
│   ├── tool.ts          Tool contract (+ ruleKey for allowlisting)
│   ├── types.ts         ChatMessage / AssistantMessage / ToolCallRequest
│   └── tools/           the six tools + shared tree walker + glob matcher
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
