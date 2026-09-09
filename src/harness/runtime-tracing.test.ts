import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ToolRegistry } from "../agent/registry.js";
import { readFileTool } from "../agent/tools/read-file.js";
import { runBashTool } from "../agent/tools/run-bash.js";
import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import { AutoApproveGate } from "../permissions/gate.js";
import type { Provider, StreamEvent } from "../providers/provider.js";
import { ContextManager } from "../context/manager.js";
import { METRIC, Observability } from "../observability/index.js";
import type { ObservabilityEvent } from "../observability/events.js";
import { SecurityManager, defaultSecurityPolicy } from "../security/index.js";
import { AgentRuntime } from "./runtime.js";

/**
 * The runtime is where LLM and tool work actually happens, so it is where the
 * spans have to come from. Without these the trace has a run and nothing
 * inside it.
 */

class ScriptedProvider implements Provider {
  readonly name = "openai";
  readonly model = "test-model";
  readonly #script: AssistantMessage[];

  constructor(script: AssistantMessage[]) {
    this.#script = script;
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    const message = this.#script.shift() ?? { role: "assistant", content: "done" };
    if (message.content) yield { type: "text-delta", delta: message.content };
    yield { type: "done", message };
  }
}

function call(id: string, name: string, args: string): AssistantMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [{ id, name, arguments: args }],
  };
}

interface Traced {
  events: ObservabilityEvent[];
  metrics: Observability["metrics"];
}

async function traceRun(
  script: AssistantMessage[],
  security?: SecurityManager,
): Promise<Traced> {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(runBashTool);

  const observability = new Observability({ level: "error" });
  const runContext = observability.newRun();
  const events: ObservabilityEvent[] = [];
  observability.bus.subscribe((event) => events.push(event));

  const runtime = new AgentRuntime({
    provider: new ScriptedProvider(script),
    registry,
    gate: new AutoApproveGate(),
    context: new ContextManager(),
    cwd: process.cwd(),
    observability,
    executionContext: runContext,
    ...(security !== undefined ? { security } : {}),
  });

  const iterator = runtime.executeLoop([{ role: "user", content: "go" }]);
  let step = await iterator.next();
  while (!step.done) step = await iterator.next();

  return { events, metrics: observability.metrics };
}

describe("runtime tracing", () => {
  it("emits LLM request events and counts them", async () => {
    const { events, metrics } = await traceRun([
      { role: "assistant", content: "hello" },
    ]);

    const started = events.filter((e) => e.type === "llm.request.started");
    const completed = events.filter((e) => e.type === "llm.request.completed");
    assert.equal(started.length, 1);
    assert.equal(completed.length, 1);
    assert.equal(started[0]?.metadata?.["provider"], "openai");
    assert.equal(completed[0]?.metadata?.["model"], "test-model");
    assert.equal(typeof completed[0]?.metadata?.["durationMs"], "number");
    assert.equal(metrics.counter(METRIC.llmRequestsTotal), 1);
    assert.ok(metrics.stats(METRIC.llmRequestDurationMs) !== undefined);
  });

  it("emits tool events with duration and increments the counters", async () => {
    const { events, metrics } = await traceRun([
      call("c1", "run_bash", JSON.stringify({ command: "node -e \"1\"" })),
      { role: "assistant", content: "done" },
    ]);

    assert.ok(events.some((e) => e.type === "tool.started"));
    const completed = events.find((e) => e.type === "tool.completed");
    assert.ok(completed, "a completed tool call must be traced");
    assert.equal(completed?.metadata?.["toolName"], "run_bash");
    assert.equal(metrics.counter(METRIC.toolCallsTotal), 1);
    assert.ok(metrics.stats(METRIC.toolCallDurationMs) !== undefined);
  });

  it("traces a blocked tool as failed, not as success", async () => {
    const security = new SecurityManager({
      policy: defaultSecurityPolicy(process.cwd(), "workspace"),
      executionId: "exec_trace",
      runId: "run_trace",
    });

    const { events, metrics } = await traceRun(
      [call("c1", "run_bash", JSON.stringify({ command: "rm -rf /" })), { role: "assistant", content: "done" }],
      security,
    );

    const failed = events.find((e) => e.type === "tool.failed");
    assert.ok(failed, "a denied tool is a failure, never a silent success");
    assert.match(String(failed?.metadata?.["reason"]), /forbidden/);
    assert.equal(metrics.counter(METRIC.toolCallsFailed), 1);
    assert.equal(events.some((e) => e.type === "tool.completed"), false);
  });

  it("stays silent when no sink is attached", async () => {
    // Observability is optional; without it nothing throws and nothing is
    // collected.
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    const runtime = new AgentRuntime({
      provider: new ScriptedProvider([{ role: "assistant", content: "ok" }]),
      registry,
      gate: new AutoApproveGate(),
      context: new ContextManager(),
      cwd: process.cwd(),
    });

    const iterator = runtime.executeLoop([{ role: "user", content: "go" }]);
    let step = await iterator.next();
    while (!step.done) step = await iterator.next();
    assert.equal(step.value.status, "completed");
  });
});
