import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { ToolRegistry } from "../agent/registry.js";
import { defaultRegistry } from "../agent/tools/index.js";
import { delegateToAgentTool, formatResult } from "../agent/tools/delegate-to-agent.js";
import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import { AutoApproveGate } from "../permissions/gate.js";
import type { Provider, StreamEvent } from "../providers/provider.js";
import { DELEGATE_TOOL_NAME, SubAgentManager } from "./manager.js";
import type { SubAgentResult } from "./types.js";

const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GLM_API_KEY"];

beforeAll(() => {
  for (const key of KEYS) process.env[key] = "test-key-not-real";
});
afterAll(() => {
  for (const key of KEYS) delete process.env[key];
});

class FixedProvider implements Provider {
  readonly name = "openai";
  readonly model = "m";
  readonly #reply: AssistantMessage;

  constructor(reply: AssistantMessage) {
    this.#reply = reply;
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    void messages;
    if (this.#reply.content !== "") {
      yield { type: "text-delta", delta: this.#reply.content };
    }
    yield { type: "done", message: this.#reply };
  }
}

function registryWith(reply: AssistantMessage): ToolRegistry {
  const registry = defaultRegistry();
  const manager = new SubAgentManager({
    parent: { provider: "openai", model: "gpt-4o-mini" },
    registry,
    gate: new AutoApproveGate(),
    cwd: process.cwd(),
    providerFactory: () => new FixedProvider(reply),
  });
  registry.register(delegateToAgentTool(manager));
  return registry;
}

describe("delegate_to_agent", () => {
  it("is registered under the expected name", () => {
    const registry = registryWith({ role: "assistant", content: "ok" });
    assert.ok(registry.get(DELEGATE_TOOL_NAME) !== undefined);
  });

  it("delegates and returns a formatted structured result", async () => {
    const registry = registryWith({ role: "assistant", content: "two issues found" });
    const output = await registry.invoke(
      DELEGATE_TOOL_NAME,
      JSON.stringify({ task: "audit auth", role: "security-reviewer" }),
      { cwd: process.cwd() },
    );

    assert.match(output.output, /sub-agent completed/);
    assert.match(output.output, /two issues found/);
    assert.match(output.output, /role: security-reviewer/);
  });

  it("rejects a spec with no task", async () => {
    const registry = registryWith({ role: "assistant", content: "ok" });
    const output = await registry.invoke(DELEGATE_TOOL_NAME, JSON.stringify({}), {
      cwd: process.cwd(),
    });
    assert.match(output.output, /invalid arguments/);
  });

  it("rejects a non-string task", async () => {
    const registry = registryWith({ role: "assistant", content: "ok" });
    const output = await registry.invoke(
      DELEGATE_TOOL_NAME,
      JSON.stringify({ task: 42 }),
      { cwd: process.cwd() },
    );
    assert.match(output.output, /invalid arguments/);
  });

  it("passes provider and context overrides through", async () => {
    const registry = registryWith({ role: "assistant", content: "analyzed" });
    const output = await registry.invoke(
      DELEGATE_TOOL_NAME,
      JSON.stringify({
        task: "audit auth",
        provider: "gemini",
        model: "gemini-2.5-pro",
        relevantContext: "monorepo",
        files: ["src/auth.ts"],
        constraints: ["do not modify files"],
      }),
      { cwd: process.cwd() },
    );

    assert.match(output.output, /sub-agent completed/);
    assert.match(output.output, /gemini \/ gemini-2\.5-pro/);
  });
});

describe("formatResult", () => {
  it("renders status, role, model, turns and summary", () => {
    const result: SubAgentResult = {
      status: "completed",
      summary: "all good",
      role: "reviewer",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      turns: 3,
    };
    const text = formatResult(result);
    assert.match(text, /sub-agent completed/);
    assert.match(text, /role: reviewer/);
    assert.match(text, /anthropic \/ claude-sonnet-4-5/);
    assert.match(text, /turns: 3/);
    assert.match(text, /all good/);
  });

  it("surfaces errors without leaking a transcript", () => {
    const text = formatResult({
      status: "failed",
      summary: "",
      role: "coder",
      errors: ["timed out"],
    });
    assert.match(text, /sub-agent failed/);
    assert.match(text, /- timed out/);
  });
});
