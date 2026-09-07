import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { ToolRegistry } from "../registry.js";
import { defaultRegistry } from "./index.js";
import { formatOrchestration, orchestrateTasksTool } from "./orchestrate-tasks.js";
import type { AssistantMessage, ChatMessage } from "../types.js";
import { AutoApproveGate } from "../../permissions/gate.js";
import type { Provider, StreamEvent } from "../../providers/provider.js";
import { ORCHESTRATE_TOOL_NAME, SubAgentManager } from "../../subagent/manager.js";
import { TaskOrchestrator } from "../../orchestration/orchestrator.js";
import type { OrchestrationResult } from "../../orchestration/types.js";

const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GLM_API_KEY"];
beforeAll(() => {
  for (const key of KEYS) process.env[key] = "test-key-not-real";
});
afterAll(() => {
  for (const key of KEYS) delete process.env[key];
});

class EchoProvider implements Provider {
  readonly name = "openai";
  readonly model = "m";
  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    const message: AssistantMessage = { role: "assistant", content: `handled: ${user.slice(0, 24)}` };
    yield { type: "text-delta", delta: message.content };
    yield { type: "done", message };
  }
}

function registryWithOrchestration(): ToolRegistry {
  const registry = defaultRegistry();
  const manager = new SubAgentManager({
    parent: { provider: "openai", model: "gpt-4o-mini" },
    registry,
    gate: new AutoApproveGate(),
    cwd: process.cwd(),
    providerFactory: () => new EchoProvider(),
  });
  registry.register(orchestrateTasksTool(new TaskOrchestrator({ manager })));
  return registry;
}

describe("orchestrate_tasks", () => {
  it("is registered under the expected name", () => {
    assert.ok(registryWithOrchestration().get(ORCHESTRATE_TOOL_NAME) !== undefined);
  });

  it("runs a valid plan and returns a concise digest", async () => {
    const registry = registryWithOrchestration();
    const output = await registry.invoke(
      ORCHESTRATE_TOOL_NAME,
      JSON.stringify({
        tasks: [
          { id: "auth", task: "Analyze authentication", role: "security-reviewer" },
          { id: "deps", task: "Analyze dependencies", role: "security-reviewer" },
          { id: "review", task: "Consolidate findings", role: "reviewer", dependencies: ["auth", "deps"] },
        ],
      }),
      { cwd: process.cwd() },
    );

    assert.match(output.output, /orchestration completed/);
    assert.match(output.output, /auth: completed/);
    assert.match(output.output, /review: completed/);
  });

  it("rejects an invalid plan before running anything", async () => {
    const registry = registryWithOrchestration();
    const output = await registry.invoke(
      ORCHESTRATE_TOOL_NAME,
      JSON.stringify({
        tasks: [
          { id: "a", task: "A", dependencies: ["b"] },
          { id: "b", task: "B", dependencies: ["a"] },
        ],
      }),
      { cwd: process.cwd() },
    );
    assert.match(output.output, /rejected/);
    assert.match(output.output, /cycle/);
  });

  it("rejects tasks without ids", async () => {
    const registry = registryWithOrchestration();
    const output = await registry.invoke(
      ORCHESTRATE_TOOL_NAME,
      JSON.stringify({ tasks: [{ task: "no id here" }] }),
      { cwd: process.cwd() },
    );
    assert.match(output.output, /invalid arguments/);
  });

  it("is withheld from sub-agents", async () => {
    const registry = registryWithOrchestration();
    const manager = new SubAgentManager({
      parent: { provider: "openai", model: "m" },
      registry,
      gate: new AutoApproveGate(),
      cwd: process.cwd(),
      providerFactory: () => new EchoProvider(),
    });
    const result = await manager.run({ task: "x", tools: [ORCHESTRATE_TOOL_NAME, "read_file"] });
    assert.ok(
      (result.errors ?? []).some((e) => /not available to sub-agents/.test(e)),
      `expected the tool to be withheld, got ${JSON.stringify(result.errors)}`,
    );
  });
});

describe("formatOrchestration", () => {
  it("falls back to a status line when there is no summary", () => {
    const result: OrchestrationResult = { runId: "r1", status: "partial", tasks: [] };
    assert.equal(formatOrchestration(result), "orchestration partial");
  });
});
