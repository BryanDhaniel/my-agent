# The AgentHarness owns the environment; the AgentRuntime owns the loop

`ChatService` had grown into two modules wearing one name: loop mechanics (stream a Turn, consult permissions, execute Tool Calls) and environment control (composition of Provider/registry/gate/context/session, system-prompt construction, persistence policy, output caps). Every caller — TUI boot, smoke scripts — re-wired that graph by hand.

We split along that fracture line instead of wrapping the class:

- **AgentRuntime** (`src/harness/runtime.ts`) receives an injected environment and executes the Agent Loop, emitting the unified event stream plus an `RuntimeOutcome` (status/finalText/turns/additions). It knows nothing about sessions or composition.
- **AgentHarness** (`src/harness/harness.ts`) is the composition root and main execution boundary: resolves session create/load, builds the system prompt from project context, folds runtime events into history + JSONL persistence, tracks Run State (including awaiting-permission via a gate wrapper), and owns cancellation/timeout signal composition.

Interaction-event shapes are unchanged, so the pure view reducer and the TUI needed no behavioral changes. Terminal lifecycle events (`agent-started/completed/failed/cancelled`, `llm-requested/completed`, `tool-requested`, `tool-failed`) are emitted by exactly one owner each: granular ones by the runtime, terminal ones by the harness.

## Considered Options

- **Wrapper class around ChatService (rejected)**: satisfies the name but not the goal; the mixed responsibilities would survive intact.
- **Harness as passive config bag (rejected)**: lifecycle/state/cancellation need an active owner; scattering them back into callers recreates the original problem.

## Consequences

- New execution surfaces (evals, subagents, CI runners) call `AgentHarness.create()` + `run()` — no wiring duplication.
- The Permission Gate's awaiting-permission tracking is centralized in the harness, so headless policies (deny-all default) and interactive prompting share one path.
- Persistence failures degrade to error events instead of killing a healthy run.
