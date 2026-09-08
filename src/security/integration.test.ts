import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { ToolRegistry } from "../agent/registry.js";
import { defaultRegistry } from "../agent/tools/index.js";
import { runBashTool } from "../agent/tools/run-bash.js";
import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import { AgentRuntime } from "../harness/runtime.js";
import { AutoApproveGate } from "../permissions/gate.js";
import type { Provider, StreamEvent } from "../providers/provider.js";
import { SubAgentManager } from "../subagent/manager.js";
import type { SubAgentEvent } from "../subagent/types.js";
import { ContextManager } from "../context/manager.js";
import { Observability, METRIC } from "../observability/index.js";
import { SecurityManager, defaultSecurityPolicy } from "./index.js";

/**
 * End-to-end: the model asks for work through the real agent loop, and the
 * security boundary is what decides. These tests prove the boundary sits on
 * the actual execution path rather than being an unused library.
 */

let workspace = "";

// The manager resolves a real key per provider even when a factory supplies
// the provider itself, so the test environment has to look configured.
const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GLM_API_KEY"];

beforeAll(() => {
  for (const key of KEYS) process.env[key] = "test-key-not-real";
  workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sec-int-"));
});

afterAll(() => {
  for (const key of KEYS) delete process.env[key];
  try {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // best effort
  }
});

/** Provider that emits exactly one tool call and then finishes. */
class ToolCallingProvider implements Provider {
  readonly name = "openai";
  readonly model = "test-model";
  readonly seen: ChatMessage[][] = [];
  readonly #call: { id: string; name: string; args: string };
  readonly #turns: number;

  constructor(call: { id: string; name: string; args: string }, turns = 2) {
    this.#call = call;
    this.#turns = turns;
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    this.seen.push(messages);
    const turn = this.seen.length;

    if (turn < this.#turns) {
      const message: AssistantMessage = {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: this.#call.id,
            name: this.#call.name,
            arguments: this.#call.args,
          },
        ],
      };
      yield { type: "done", message };
      return;
    }

    const message: AssistantMessage = { role: "assistant", content: "finished" };
    yield { type: "text-delta", delta: "finished" };
    yield { type: "done", message };
  }
}

interface RunResult {
  toolOutputs: string[];
  denials: string[];
  status: string;
}

async function runWithSecurity(call: {
  id: string;
  name: string;
  args: string;
}): Promise<RunResult> {
  const registry = new ToolRegistry();
  registry.register(runBashTool);

  const observability = new Observability({ level: "error" });
  const security = new SecurityManager({
    policy: defaultSecurityPolicy(workspace, "workspace"),
    observability,
    executionId: "exec_integration",
    runId: "run_integration",
    label: "main",
  });

  const runtime = new AgentRuntime({
    provider: new ToolCallingProvider(call),
    registry,
    gate: new AutoApproveGate(),
    context: new ContextManager(),
    cwd: workspace,
    security,
  });

  const toolOutputs: string[] = [];
  const denials: string[] = [];
  let status = "unknown";

  const iterator = runtime.executeLoop([{ role: "user", content: "do the thing" }]);
  let next = await iterator.next();
  while (!next.done) {
    const event = next.value;
    if (event.type === "tool-result") toolOutputs.push(event.output);
    if (event.type === "tool-denied") denials.push(event.reason);
    if (event.type === "agent-completed") status = event.status;
    next = await iterator.next();
  }
  if (next.done && next.value) status = next.value.status;

  // Every denial is counted, so an operator can see the block without
  // reading the transcript.
  assert.ok(observability.metrics.counter(METRIC.securityChecksTotal) >= 1);
  return { toolOutputs, denials, status };
}

describe("security on the real execution path", () => {
  it("blocks a forbidden command requested by the model", async () => {
    const result = await runWithSecurity({
      id: "call_1",
      name: "run_bash",
      args: JSON.stringify({ command: "rm -rf /" }),
    });

    assert.equal(result.denials.length, 1, "exactly one denial");
    assert.match(result.denials[0] ?? "", /forbidden command pattern/);
    assert.match(result.toolOutputs[0] ?? "", /Blocked by security policy/);
    assert.equal(result.status, "completed", "a blocked tool does not crash the run");
  });

  it("lets a safe command through to execution", async () => {
    const result = await runWithSecurity({
      id: "call_2",
      name: "run_bash",
      args: JSON.stringify({ command: `node -e "console.log('safe-ok')"` }),
    });

    assert.equal(result.denials.length, 0);
    assert.match(result.toolOutputs[0] ?? "", /safe-ok/);
  });

  it("blocks a chained command whose second half is destructive", async () => {
    const result = await runWithSecurity({
      id: "call_3",
      name: "run_bash",
      args: JSON.stringify({ command: "echo harmless && rm -rf /" }),
    });

    assert.equal(result.denials.length, 1);
    assert.match(result.toolOutputs[0] ?? "", /Blocked by security policy/);
  });
});

describe("sub-agent isolation", () => {
  it("gives a child a narrowed context, not the parent's full authority", async () => {
    // Roles expect the standard tool set, so use the real registry here.
    const registry = defaultRegistry();

    const observability = new Observability({ level: "error" });
    const security = new SecurityManager({
      policy: defaultSecurityPolicy(workspace, "workspace"),
      observability,
      executionId: "exec_parent",
      runId: "run_parent",
      label: "main",
    });

    const events: SubAgentEvent[] = [];
    const manager = new SubAgentManager({
      parent: { provider: "openai", model: "test-model" },
      registry,
      gate: new AutoApproveGate(),
      cwd: workspace,
      security,
      onEvent: (event) => events.push(event),
      providerFactory: () =>
        new (class implements Provider {
          readonly name = "openai";
          readonly model = "test-model";
          async *stream(): AsyncGenerator<StreamEvent> {
            const message: AssistantMessage = { role: "assistant", content: "child done" };
            yield { type: "text-delta", delta: "child done" };
            yield { type: "done", message };
          }
        })(),
    });

    const result = await manager.run({ task: "review the code", role: "reviewer" }, {});
    assert.equal(
      result.status,
      "completed",
      JSON.stringify({ errors: result.errors, turns: result.turns, summary: result.summary }),
    );
    assert.ok(events.some((e) => e.type === "subagent.created"));

    // The default child subset has filesystem read/write but no shell.
    const child = security.child({ executionId: "exec_child", label: "reviewer" });
    assert.equal(child.capabilities.has("filesystem.read"), true);
    assert.equal(child.capabilities.has("process.execute"), false);

    const command = child.checkCommand("git status");
    assert.equal(command.allowed, false, "a reviewer child must not run shell commands");
  });

  it("refuses a child that asks for capabilities the parent lacks", () => {
    const observability = new Observability({ level: "error" });
    const parent = new SecurityManager({
      policy: defaultSecurityPolicy(workspace, "restricted"),
      observability,
      executionId: "exec_parent",
      runId: "run_parent",
    });

    const before = observability.metrics.counter(METRIC.securityChecksTotal);
    const child = parent.child({
      executionId: "exec_child",
      capabilities: ["process.execute", "mcp.admin"],
      label: "coder",
    });

    assert.equal(child.capabilities.size, 0, "restricted parent grants nothing dangerous");
    assert.ok(
      observability.metrics.counter(METRIC.securityChecksTotal) > before,
      "the escalation attempt is audited",
    );
  });
});

describe("no orphaned state after a denial", () => {
  it("does not create files when a write is blocked", async () => {
    const target = path.join(workspace, "should-not-exist.txt");
    const security = new SecurityManager({
      policy: defaultSecurityPolicy(workspace, "workspace"),
      executionId: "exec_deny",
    });

    const decision = await security.checkFileAccess(".env", "write");
    assert.equal(decision.allowed, false);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(workspace, ".env")), false);
  });

  it("reports a useful reason rather than a bare denial", async () => {
    const security = new SecurityManager({
      policy: defaultSecurityPolicy(workspace, "workspace"),
      executionId: "exec_reason",
    });
    const decision = await security.checkFileAccess("../outside/file.txt", "read");
    assert.match(decision.reason, /outside the configured workspace/);
    assert.notEqual(decision.reason, "Access denied.");
  });
});
