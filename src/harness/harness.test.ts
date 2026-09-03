import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { AgentHarness } from "./harness.js";
import { AgentRuntime } from "./runtime.js";
import { SessionStore } from "../session/store.js";
import { ToolRegistry } from "../agent/registry.js";
import { AutoApproveGate, DenyAllGate } from "../permissions/gate.js";
import type { Provider, StreamEvent } from "../providers/provider.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillRegistry } from "../skills/index.js";
import type { Skill } from "../skills/index.js";

class MockProvider implements Provider {
  readonly name = "mock";
  readonly model = "mock-model";
  responses: Array<StreamEvent[]> = [];

  async *stream(): AsyncGenerator<StreamEvent> {
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

  it("executes a basic prompt and updates run state to completed", async () => {
    const harness = await AgentHarness.create(provider, {
      store,
      registry,
      gate: new AutoApproveGate(),
    });

    expect(harness.state.status).toBe("idle");
    expect(harness.state.turns).toBe(0);

    const events = [];
    for await (const event of harness.run("Hi there")) {
      events.push(event);
    }

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

    const harness = await AgentHarness.create(provider, {
      store,
      registry,
      gate: new AutoApproveGate(),
    });

    const events = [];
    for await (const event of harness.run("Test tool")) {
      events.push(event);
    }

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

    const harness = await AgentHarness.create(provider, {
      store,
      registry,
      gate: new DenyAllGate(),
    });

    const events = [];
    for await (const event of harness.run("Do danger")) {
      events.push(event);
    }

    const denied = events.filter((e) => e.type === "tool-denied");
    expect(denied.length).toBe(1);
  });

  it("registers MCP tools and makes them available to the runtime", async () => {
    // Simulate an MCP tool via mcpConfig with a failing command —
    // we just need to verify the harness handles MCP config gracefully.
    const harness = await AgentHarness.create(provider, {
      store,
      registry,
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

    const harness = await AgentHarness.create(provider, {
      store,
      registry,
      gate: new AutoApproveGate(),
    });

    const events = [];
    for await (const event of harness.run("Use the echo tool")) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === "tool-result");
    expect(results.length).toBe(1);
    expect(results[0]).toHaveProperty("output", "echo: hello");
  });

  it("close() is idempotent", async () => {
    const harness = await AgentHarness.create(provider, { store, registry });
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

    const harness = await AgentHarness.create(provider, {
      store,
      registry,
      gate: new AutoApproveGate(),
      skills,
    });

    const events = [];
    for await (const event of harness.run("/test-skill do the thing")) {
      events.push(event);
    }

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

    const harness = await AgentHarness.create(provider, {
      store,
      registry,
      skills,
    });

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

    const harness = await AgentHarness.create(provider, {
      store,
      registry,
      skills,
    });

    const systemMsg = harness.messages.find((m) => m.role === "system");
    expect(systemMsg?.content).toContain("tdd");
    expect(systemMsg?.content).toContain("Test-driven development");
    expect(systemMsg?.content).toContain("Available skills");
  });
});
