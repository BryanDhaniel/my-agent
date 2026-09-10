import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { AgentHarness, buildSystemPrompt } from "./harness.js";
import { AgentRuntime } from "./runtime.js";
import { SessionStore } from "../session/store.js";
import { ToolRegistry } from "../agent/registry.js";
import { AutoApproveGate, DenyAllGate } from "../permissions/gate.js";
import { ContextManager } from "../context/manager.js";
import { LocalMemoryStore, MemoryManager } from "../memory/index.js";
import type { Provider, StreamEvent } from "../providers/provider.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillRegistry } from "../skills/index.js";
import type { Skill } from "../skills/index.js";
import type { AgentEvent } from "./events.js";
import type { AgentHarnessOptions } from "./harness.js";

class MockProvider implements Provider {
  readonly name = "mock";
  readonly model = "mock-model";
  responses: Array<StreamEvent[]> = [];
  /** Everything the model was last shown, for context assertions. */
  lastMessages: import("../agent/types.js").ChatMessage[] = [];

  async *stream(
    messages: import("../agent/types.js").ChatMessage[],
  ): AsyncGenerator<StreamEvent> {
    this.lastMessages = messages;
    const events = this.responses.shift() ?? [
      {
        type: "done",
        message: { role: "assistant", content: "Hello from mock!" },
      },
    ];
    for (const ev of events) {
      yield ev;
    }
  }
}

describe("AgentHarness & AgentRuntime", () => {
  let tmpDir: string;
  let store: SessionStore;
  let provider: MockProvider;
  let registry: ToolRegistry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-test-"));
    store = new SessionStore(tmpDir);
    provider = new MockProvider();
    registry = new ToolRegistry();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Every harness in this file runs inside the temp directory, so the default
   * memory store never touches the real project.
   */
  function create(opts: AgentHarnessOptions = {}): Promise<AgentHarness> {
    return AgentHarness.create(provider, { store, registry, cwd: tmpDir, ...opts });
  }

  async function run(harness: AgentHarness, text: string): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of harness.run(text)) {
      events.push(event);
    }
    return events;
  }

  it("executes a basic prompt and updates run state to completed", async () => {
    const harness = await create({ gate: new AutoApproveGate() });

    expect(harness.state.status).toBe("idle");
    expect(harness.state.turns).toBe(0);

    const events = await run(harness, "Hi there");

    expect(harness.state.status).toBe("completed");
    expect(harness.state.turns).toBe(1);

    const types = events.map((e) => e.type);
    expect(types).toContain("agent-started");
    expect(types).toContain("user-message");
    expect(types).toContain("llm-requested");
    expect(types).toContain("llm-completed");
    expect(types).toContain("assistant-message");
    expect(types).toContain("agent-completed");
  });

  it("handles tool calls and records results", async () => {
    registry.register({
      name: "echo",
      description: "Echo input",
      mutating: false,
      schema: z.object({ text: z.string() }),
      execute: async (input: { text: string }) => ({ output: `Echo: ${input.text}` }),
    });

    provider.responses = [
      [
        {
          type: "done",
          message: {
            role: "assistant",
            content: "Using tool",
            toolCalls: [{ id: "call_1", name: "echo", arguments: '{"text":"hello"}' }],
          },
        },
      ],
      [
        {
          type: "done",
          message: { role: "assistant", content: "Done!" },
        },
      ],
    ];

    const harness = await create({ gate: new AutoApproveGate() });

    const events = await run(harness, "Test tool");

    expect(harness.state.status).toBe("completed");
    expect(harness.state.turns).toBe(2);

    const toolResults = events.filter((e) => e.type === "tool-result");
    expect(toolResults.length).toBe(1);
    const firstResult = toolResults[0];
    if (firstResult && firstResult.type === "tool-result") {
      expect(firstResult.output).toBe("Echo: hello");
    }
  });

  it("wraps DenyAllGate so awaiting-permission is tracked properly", async () => {
    registry.register({
      name: "danger",
      description: "Mutating action",
      mutating: true,
      schema: z.object({}),
      execute: async () => ({ output: "ok" }),
    });

    provider.responses = [
      [
        {
          type: "done",
          message: {
            role: "assistant",
            content: "Calling danger",
            toolCalls: [{ id: "call_1", name: "danger", arguments: "{}" }],
          },
        },
      ],
      [
        {
          type: "done",
          message: { role: "assistant", content: "Understood." },
        },
      ],
    ];

    const harness = await create({ gate: new DenyAllGate() });

    const events = await run(harness, "Do danger");

    const denied = events.filter((e) => e.type === "tool-denied");
    expect(denied.length).toBe(1);
  });

  it("registers MCP tools and makes them available to the runtime", async () => {
    // Simulate an MCP tool via mcpConfig with a failing command —
    // we just need to verify the harness handles MCP config gracefully.
    const harness = await create({
      gate: new AutoApproveGate(),
      mcpConfig: {
        servers: {
          fake: { command: "__nonexistent_mcp_server__" },
        },
      },
    });

    // The fake server fails, but the harness still starts.
    expect(harness.mcpStatuses.length).toBe(1);
    expect(harness.mcpStatuses[0]?.status).toBe("failed");

    // close() should be safe even when no MCP servers are connected.
    await harness.close();
  });

  it("registerAll adds MCP-style tools that are invokable through the registry", async () => {
    const mcpTool = {
      name: "mcp.test.echo",
      description: "Echo tool from MCP",
      mutating: true,
      schema: z.object({ text: z.string() }),
      async execute(input: unknown) {
        const { text } = input as { text: string };
        return { output: `echo: ${text}` };
      },
    };

    registry.register(mcpTool);

    // Provider returns a response that calls the MCP tool.
    provider.responses = [
      [
        {
          type: "done",
          message: {
            role: "assistant",
            content: "Using the MCP echo tool",
            toolCalls: [
              { id: "mcp_1", name: "mcp.test.echo", arguments: '{"text":"hello"}' },
            ],
          },
        },
      ],
      [
        {
          type: "done",
          message: { role: "assistant", content: "The echo returned: echo: hello" },
        },
      ],
    ];

    const harness = await create({ gate: new AutoApproveGate() });

    const events = await run(harness, "Use the echo tool");

    const results = events.filter((e) => e.type === "tool-result");
    expect(results.length).toBe(1);
    expect(results[0]).toHaveProperty("output", "echo: hello");
  });

  it("close() is idempotent", async () => {
    const harness = await create();
    await harness.close();
    await harness.close(); // should not throw
  });

  it("emits skill-activated when user invokes a skill via /name", async () => {
    const skills = new SkillRegistry();
    const testSkill: Skill = {
      name: "test-skill",
      description: "A test skill.",
      instructions: "Greet the user warmly.",
      invocation: "user",
      source: "/skills/test",
    };
    skills.register(testSkill);

    provider.responses = [
      [
        {
          type: "done",
          message: { role: "assistant", content: "Hello! I'm using the test skill." },
        },
      ],
    ];

    const harness = await create({ gate: new AutoApproveGate(), skills });

    const events = await run(harness, "/test-skill do the thing");

    const activated = events.filter((e) => e.type === "skill-activated");
    expect(activated.length).toBe(1);
    expect(activated[0]).toHaveProperty("name", "test-skill");
  });

  it("skillCommands returns user-invoked skills", async () => {
    const skills = new SkillRegistry();
    skills.register({
      name: "impl",
      description: "Implement things.",
      instructions: "...",
      invocation: "user",
      source: "/s/impl",
    });
    skills.register({
      name: "auto-review",
      description: "Review code.",
      instructions: "...",
      invocation: "model",
      source: "/s/review",
    });

    const harness = await create({ skills });

    const cmds = harness.skillCommands;
    expect(cmds.length).toBe(1);
    expect(cmds[0]?.name).toBe("impl");
  });

  it("model-invoked skills appear in system prompt", async () => {
    const skills = new SkillRegistry();
    skills.register({
      name: "tdd",
      description: "Test-driven development.",
      instructions: "Red green refactor.",
      invocation: "model",
      source: "/s/tdd",
    });

    const harness = await create({ skills });

    const systemMsg = harness.messages.find((m) => m.role === "system");
    expect(systemMsg?.content).toContain("tdd");
    expect(systemMsg?.content).toContain("Test-driven development");
    expect(systemMsg?.content).toContain("Available skills");
  });
});

describe("AgentHarness context lifecycle", () => {
  let tmpDir: string;
  let store: SessionStore;
  let provider: MockProvider;
  let registry: ToolRegistry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-context-"));
    store = new SessionStore(tmpDir);
    provider = new MockProvider();
    registry = new ToolRegistry();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function create(opts: AgentHarnessOptions = {}): Promise<AgentHarness> {
    return AgentHarness.create(provider, { store, registry, cwd: tmpDir, ...opts });
  }

  async function run(harness: AgentHarness, text: string): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of harness.run(text)) {
      events.push(event);
    }
    return events;
  }

  const seen = (harness: AgentHarness): string =>
    provider.lastMessages.map((m) => m.content).join("\n");

  it("sends the task and permission constraints to the model", async () => {
    const harness = await create();
    await run(harness, "Refactor the parser");
    const text = seen(harness);

    expect(text).toContain("## Active task");
    expect(text).toContain("Refactor the parser");
    expect(text).toContain("## Permissions");
  });

  it("routes skill instructions through the ContextManager, not the transcript", async () => {
    const skills = new SkillRegistry();
    skills.register({
      name: "greet",
      description: "Greet warmly.",
      instructions: "Always greet the user warmly.",
      invocation: "user",
      source: "/s/greet",
    });

    const harness = await create({ skills });
    const events = await run(harness, "/greet hello");

    expect(events.some((e) => e.type === "skill-activated")).toBe(true);
    expect(seen(harness)).toContain("Always greet the user warmly");
    // Skill text must not accumulate in the persisted session.
    expect(harness.messages.some((m) => m.content.includes("Always greet the user warmly"))).toBe(
      false,
    );
  });

  it("folds an oversized conversation into a summary and persists it", async () => {
    const context = new ContextManager({
      maxTokens: 200,
      reservedOutputTokens: 0,
      compactThreshold: 0.1,
      protectedGroups: 1,
      keepShare: 0.2,
    });

    const harness = await create({ context });
    await run(harness, "first question about the architecture of this repository");
    const events = await run(harness, "second question about the architecture of this repository");

    expect(events.some((e) => e.type === "context-compacted")).toBe(true);

    const reloaded = await store.load(harness.id);
    expect(reloaded?.summary).toBeDefined();
    expect(reloaded?.summary?.coveredMessages).toBeGreaterThan(0);
    // The transcript itself is untouched.
    expect(reloaded?.messages.length).toBe(4);

    // Compaction happens after the last request, so inspect what the next
    // request would contain rather than what the model just saw.
    const next = harness.context.buildContext(harness.messages);
    expect(next.map((m) => m.content).join("\n")).toContain(
      "Earlier in this session (compacted)",
    );
  });

  it("restores the compaction when the session is resumed", async () => {
    const makeContext = () =>
      new ContextManager({
        maxTokens: 200,
        reservedOutputTokens: 0,
        compactThreshold: 0.1,
        protectedGroups: 1,
        keepShare: 0.2,
      });

    const first = await create({ context: makeContext() });
    await run(first, "first question about the architecture of this repository");
    await run(first, "second question about the architecture of this repository");

    const resumed = await create({ sessionId: first.id, context: makeContext() });
    expect(resumed.context.summary).toBeDefined();

    const context = resumed.context.buildContext(resumed.messages);
    expect(context.map((m) => m.content).join("\n")).toContain(
      "Earlier in this session (compacted)",
    );
    // The covered turn is gone from the conversation — it only survives
    // inside the summary's own task line.
    const userTurns = context.filter((m) => m.role === "user").map((m) => m.content);
    expect(userTurns).toEqual(["second question about the architecture of this repository"]);
  });

  it("starts a new session with a clean context", async () => {
    const makeContext = () =>
      new ContextManager({
        maxTokens: 200,
        reservedOutputTokens: 0,
        compactThreshold: 0.1,
        protectedGroups: 1,
        keepShare: 0.2,
      });

    const harness = await create({ context: makeContext() });
    await run(harness, "first question about the architecture of this repository");
    await run(harness, "second question about the architecture of this repository");
    expect(harness.context.summary).toBeDefined();

    await harness.newSession();
    expect(harness.context.summary).toBeUndefined();
    expect(harness.messages.length).toBe(1); // system prompt only
  });

  it("switching sessions restores that session's summary", async () => {
    const makeContext = () =>
      new ContextManager({
        maxTokens: 200,
        reservedOutputTokens: 0,
        compactThreshold: 0.1,
        protectedGroups: 1,
        keepShare: 0.2,
      });

    const harness = await create({ context: makeContext() });
    await run(harness, "first question about the architecture of this repository");
    await run(harness, "second question about the architecture of this repository");
    const compactedId = harness.id;

    await harness.newSession();
    await harness.switchTo(compactedId);
    expect(harness.context.summary).toBeDefined();
  });
});

describe("AgentHarness memory lifecycle", () => {
  let tmpDir: string;
  let store: SessionStore;
  let provider: MockProvider;
  let registry: ToolRegistry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-memory-"));
    store = new SessionStore(tmpDir);
    provider = new MockProvider();
    registry = new ToolRegistry();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function create(opts: AgentHarnessOptions = {}): Promise<AgentHarness> {
    return AgentHarness.create(provider, { store, registry, cwd: tmpDir, ...opts });
  }

  async function run(harness: AgentHarness, text: string): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of harness.run(text)) {
      events.push(event);
    }
    return events;
  }

  const seen = (): string => provider.lastMessages.map((m) => m.content).join("\n");

  it("injects relevant memories into the request", async () => {
    const harness = await create();
    await harness.memory!.store({
      content: "The project uses vitest for tests and typecheck before commits.",
      category: "project",
      source: "seed",
    });

    const events = await run(harness, "how should I run the tests?");

    expect(events.some((e) => e.type === "memory-recalled")).toBe(true);
    expect(seen()).toContain("The project uses vitest");
  });

  it("does not inject memories that have nothing to do with the task", async () => {
    const harness = await create();
    await harness.memory!.store({
      content: "The deployment pipeline runs on Fridays.",
      category: "project",
      source: "seed",
    });

    const events = await run(harness, "how should I run the tests?");

    expect(events.some((e) => e.type === "memory-recalled")).toBe(false);
    expect(seen()).not.toContain("deployment pipeline");
  });

  it("extracts durable statements from a run and persists them", async () => {
    const harness = await create();
    const events = await run(harness, "Remember that we deploy on Fridays.");

    const stored = events.find((e) => e.type === "memory-stored");
    expect(stored).toHaveProperty("count", 1);

    const memories = await harness.memory!.list();
    expect(memories.length).toBe(1);
    expect(memories[0]?.content).toContain("deploy on Fridays");
    expect(memories[0]?.source).toBe(`session:${harness.id}`);
  });

  it("ignores ordinary requests instead of filling the store", async () => {
    const harness = await create();
    await run(harness, "please look at src/agent/types.ts and tell me what it does");

    expect(await harness.memory!.list()).toEqual([]);
  });

  it("never persists a secret offered as a memory", async () => {
    const harness = await create();
    const events = await run(
      harness,
      "Remember that the deploy token is ghp_" + "abcdefghijklmnopqrstuvwxyz1234",
    );

    const stored = events.find((e) => e.type === "memory-stored");
    expect(stored).toHaveProperty("count", 0);
    expect(await harness.memory!.list()).toEqual([]);
  });

  it("survives a restart: a later session recalls an earlier one's memory", async () => {
    const memoryStore = new LocalMemoryStore(join(tmpDir, ".memory", "memories.jsonl"));

    const first = await create({ memoryStore });
    await run(first, "Remember that we deploy on Fridays.");

    const second = await create({ memoryStore });
    const events = await run(second, "when do we deploy?");

    expect(events.some((e) => e.type === "memory-recalled")).toBe(true);
    expect(seen()).toContain("deploy on Fridays");
  });

  it("keeps memory when the session is replaced", async () => {
    const harness = await create();
    await harness.memory!.store({
      content: "Sessions are append-only JSONL.",
      category: "architecture",
      source: "seed",
    });

    await harness.newSession();

    // A fresh Session, the same durable knowledge.
    expect(await harness.memory!.list()).toHaveLength(1);
  });

  it("accepts an injected MemoryManager without touching the default store", async () => {
    const injected = await MemoryManager.create({
      store: new LocalMemoryStore(join(tmpDir, "injected", "memories.jsonl")),
    });
    const harness = await create({ memory: injected });
    expect(harness.memory).toBe(injected);
  });
});

describe("buildSystemPrompt", () => {
  it("tells the model not to call tools for greetings or small talk", () => {
    const prompt = buildSystemPrompt("/project", "src\npackage.json");
    // Regression: a weak model greeted with "Hello" would spontaneously call
    // run_bash. The prompt must explicitly forbid tools for small talk.
    expect(prompt).toMatch(/greeting/i);
    expect(prompt).toMatch(/without calling any tools|call no tools/i);
    // And it must still be a coding-agent prompt with the project root.
    expect(prompt).toContain("coding agent");
    expect(prompt).toContain("Project root: /project");
  });
});
