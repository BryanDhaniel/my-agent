import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { defaultRegistry } from "../agent/tools/index.js";
import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import type { ProviderName } from "../config.js";
import { AutoApproveGate, DenyAllGate } from "../permissions/gate.js";
import type { Provider, StreamEvent } from "../providers/provider.js";
import { SubAgentManager } from "./manager.js";
import type { SubAgentEvent } from "./types.js";

const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GLM_API_KEY"];

beforeAll(() => {
  for (const key of KEYS) process.env[key] = "test-key-not-real";
});
afterAll(() => {
  for (const key of KEYS) delete process.env[key];
});

/** Replays scripted assistant messages and records what it was shown. */
class ScriptedProvider implements Provider {
  readonly name: string;
  readonly model: string;
  readonly seen: ChatMessage[][] = [];
  #responses: AssistantMessage[];
  #index = 0;

  constructor(name: string, model: string, responses: AssistantMessage[]) {
    this.name = name;
    this.model = model;
    this.#responses = responses;
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    this.seen.push(messages);
    const message: AssistantMessage =
      this.#responses[Math.min(this.#index, this.#responses.length - 1)] ??
      { role: "assistant", content: "" };
    this.#index++;
    if (message.content !== "") yield { type: "text-delta", delta: message.content };
    yield { type: "done", message };
  }
}

class HangingProvider implements Provider {
  readonly name = "openai";
  readonly model = "m";
  async *stream(): AsyncGenerator<StreamEvent> {
    await new Promise<never>(() => {});
  }
}

interface Harness {
  manager: SubAgentManager;
  events: SubAgentEvent[];
  built: Array<{ provider: ProviderName; model: string }>;
}

function setup(options: {
  parent?: { provider: ProviderName; model: string };
  gate?: ConstructorParameters<typeof SubAgentManager>[0]["gate"];
  responses: AssistantMessage[];
  maxDepth?: number;
  hanging?: boolean;
}): Harness {
  const events: SubAgentEvent[] = [];
  const built: Array<{ provider: ProviderName; model: string }> = [];
  const parent = options.parent ?? { provider: "openai" as ProviderName, model: "gpt-4o-mini" };

  const manager = new SubAgentManager({
    parent,
    registry: defaultRegistry(),
    gate: options.gate ?? new AutoApproveGate(),
    cwd: process.cwd(),
    ...(options.maxDepth !== undefined ? { maxSubAgentDepth: options.maxDepth } : {}),
    onEvent: (event) => events.push(event),
    providerFactory: ({ provider, model }) => {
      built.push({ provider, model });
      return options.hanging === true
        ? new HangingProvider()
        : new ScriptedProvider(provider, model, options.responses);
    },
  });

  return { manager, events, built };
}

const text = (content: string): AssistantMessage => ({ role: "assistant", content });

describe("SubAgentManager", () => {
  it("completes and returns the child's final text as the summary", async () => {
    const { manager, events } = setup({ responses: [text("two issues found")] });
    const result = await manager.run({ task: "audit auth" });

    assert.equal(result.status, "completed");
    assert.equal(result.summary, "two issues found");
    assert.equal(result.role, "general");
    assert.ok(events.some((e) => e.type === "subagent.created"));
    assert.ok(events.some((e) => e.type === "subagent.completed"));
  });

  it("emits lifecycle events in order", async () => {
    const { manager, events } = setup({ responses: [text("done")] });
    await manager.run({ task: "x", role: "reviewer" });
    assert.deepEqual(
      events.map((e) => e.type),
      ["subagent.created", "subagent.started", "subagent.completed"],
    );
  });
});

describe("provider selection", () => {
  it("inherits the parent provider and model when unspecified", async () => {
    const { manager, built } = setup({
      parent: { provider: "openai", model: "gpt-4o" },
      responses: [text("ok")],
    });
    const result = await manager.run({ task: "x" });
    assert.deepEqual(built, [{ provider: "openai", model: "gpt-4o" }]);
    assert.equal(result.provider, "openai");
    assert.equal(result.model, "gpt-4o");
  });

  it("uses an explicit provider and model override", async () => {
    const { manager, built } = setup({
      parent: { provider: "openai", model: "gpt-4o" },
      responses: [text("ok")],
    });
    const result = await manager.run({
      task: "x",
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
    assert.deepEqual(built, [{ provider: "gemini", model: "gemini-2.5-pro" }]);
    assert.equal(result.provider, "gemini");
    assert.equal(result.model, "gemini-2.5-pro");
  });

  it("inherits the model but overrides only the provider", async () => {
    const { manager, built } = setup({
      parent: { provider: "openai", model: "gpt-4o" },
      responses: [text("ok")],
    });
    await manager.run({ task: "x", provider: "glm" });
    assert.deepEqual(built, [{ provider: "glm", model: "gpt-4o" }]);
  });

  it("fails cleanly on an unknown provider", async () => {
    const { manager } = setup({ responses: [text("ok")] });
    const result = await manager.run({ task: "x", provider: "llama" });
    assert.equal(result.status, "failed");
    assert.match(result.errors?.[0] ?? "", /unknown provider/);
  });
});

describe("configuration validation", () => {
  it("refuses a missing task", async () => {
    const { manager } = setup({ responses: [text("ok")] });
    const result = await manager.run({ task: "   " });
    assert.equal(result.status, "failed");
    assert.match(result.errors?.[0] ?? "", /missing a task/);
  });

  it("refuses an unknown role instead of guessing", async () => {
    const { manager } = setup({ responses: [text("ok")] });
    const result = await manager.run({ task: "x", role: "wizard" });
    assert.equal(result.status, "failed");
    assert.match(result.errors?.[0] ?? "", /unknown role "wizard"/);
  });

  it("refuses unknown tools but keeps the usable ones", async () => {
    const { manager } = setup({ responses: [text("ok")] });
    const result = await manager.run({ task: "x", tools: ["read_file", "nope"] });
    assert.equal(result.status, "completed");
    assert.match(result.errors?.[0] ?? "", /unknown tool "nope"/);
  });
});

describe("context isolation", () => {
  it("shows the child only the task, never the parent conversation", async () => {
    const responses = [text("ok")];
    const events: SubAgentEvent[] = [];
    const provider = new ScriptedProvider("openai", "m", responses);
    const manager = new SubAgentManager({
      parent: { provider: "openai", model: "m" },
      registry: defaultRegistry(),
      gate: new AutoApproveGate(),
      cwd: process.cwd(),
      onEvent: (e) => events.push(e),
      providerFactory: () => provider,
    });

    await manager.run(
      { task: "audit auth" },
      { context: { relevantContext: "monorepo", files: ["src/a.ts"] } },
    );

    const shown = provider.seen[0] ?? [];
    // No parent history: only system/task scaffolding plus the task message.
    const userTurns = shown.filter((m) => m.role === "user");
    assert.equal(userTurns.length, 1);
    assert.match(String(userTurns[0]?.content ?? ""), /audit auth/);
    assert.match(String(userTurns[0]?.content ?? ""), /monorepo/);
    assert.match(String(userTurns[0]?.content ?? ""), /src\/a\.ts/);
  });
});

describe("permissions", () => {
  it("cannot bypass the permission gate", async () => {
    const { manager } = setup({
      gate: new DenyAllGate(),
      responses: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "t1", name: "write_file", arguments: '{"path":"a.txt","content":"x"}' }],
        },
        text("gave up"),
      ],
    });

    const result = await manager.run({ task: "write a file", role: "coder" });
    assert.ok(
      (result.errors ?? []).some((e) => /permission denied/.test(e)),
      `expected a permission denial, got ${JSON.stringify(result.errors)}`,
    );
  });

  it("restricts a read-only role from write tools", async () => {
    const { manager } = setup({
      responses: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "t1", name: "write_file", arguments: '{"path":"a.txt","content":"x"}' }],
        },
        text("cannot"),
      ],
    });

    const result = await manager.run({ task: "write", role: "researcher" });
    assert.ok(
      (result.errors ?? []).some((e) => /unknown tool "write_file"/.test(e)),
      `expected write_file to be unavailable, got ${JSON.stringify(result.errors)}`,
    );
  });
});

describe("limits and cancellation", () => {
  it("blocks nested delegation past the depth limit", async () => {
    const { manager } = setup({ responses: [text("ok")], maxDepth: 1 });
    const result = await manager.run({ task: "x" }, { depth: 1 });
    assert.equal(result.status, "failed");
    assert.match(result.errors?.[0] ?? "", /depth limit reached/);
  });

  it("fails with a structured error on timeout", async () => {
    const { manager, events } = setup({ responses: [text("ok")], hanging: true });
    const result = await manager.run({ task: "x", timeoutMs: 30 });
    assert.equal(result.status, "failed");
    assert.ok((result.errors ?? []).some((e) => /timed out/.test(e)));
    assert.ok(events.some((e) => e.type === "subagent.failed"));
  });

  it("reports cancelled when the parent aborts", async () => {
    const { manager } = setup({ responses: [text("ok")], hanging: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await manager.run({ task: "x", timeoutMs: 5_000 }, { signal: controller.signal });
    assert.equal(result.status, "cancelled");
  });

  it("enforces the maxTurns limit", async () => {
    const { manager } = setup({
      responses: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "t1", name: "read_file", arguments: '{"path":"package.json"}' }],
        },
      ],
    });
    const result = await manager.run({ task: "loop forever", maxTurns: 1 });
    assert.equal(result.status, "failed");
    assert.ok((result.errors ?? []).some((e) => /1-Turn limit/.test(e)));
  });
});
