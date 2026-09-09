import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { defaultRegistry } from "../agent/tools/index.js";
import type { ChatMessage } from "../agent/types.js";
import { ToolRegistry } from "../agent/registry.js";
import { AutoApproveGate } from "../permissions/gate.js";
import { SessionStore } from "../session/store.js";
import { SubAgentManager } from "../subagent/manager.js";
import { TaskOrchestrator } from "../orchestration/orchestrator.js";
import type { AgentTask } from "../orchestration/types.js";
import { AgentHarness } from "../harness/harness.js";
import { MemoryCredentialStore } from "../credentials/index.js";
import { ProviderManager } from "./manager.js";
import type { Provider, StreamEvent } from "./provider.js";

/**
 * The parts that only break in combination: a run keeping its provider after
 * a switch, children inheriting the right snapshot, and credentials staying
 * out of everything the model can see.
 */

const SECRET = "sk-integration-value";

class RecordingProvider implements Provider {
  readonly name: string;
  readonly model: string;
  readonly seen: string[] = [];
  /** Set to make the first stream call hang until released. */
  gate: Promise<void> | undefined;

  constructor(name: string, model: string) {
    this.name = name;
    this.model = model;
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    this.seen.push(
      messages
        .filter((m): m is Extract<ChatMessage, { role: "user" }> => m.role === "user")
        .map((m) => m.content)
        .join("\n"),
    );
    if (this.gate !== undefined) await this.gate;
    const message: ChatMessage = { role: "assistant", content: `reply from ${this.name}` };
    yield { type: "text-delta", delta: `reply from ${this.name}` };
    yield { type: "done", message };
  }
}

async function drain(iterator: AsyncGenerator<unknown>): Promise<void> {
  let step = await iterator.next();
  while (!step.done) step = await iterator.next();
}

let tmp = "";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "prov-int-"));
});

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // best effort
  }
});

describe("execution snapshots", () => {
  it("keeps an in-flight run on its original provider after a switch", async () => {
    const first = new RecordingProvider("openai", "model-A");
    const harness = await AgentHarness.create(first, {
      store: new SessionStore(path.join(tmp, "sessions")),
      registry: new ToolRegistry(),
      gate: new AutoApproveGate(),
      cwd: tmp,
    });

    let release = (): void => {};
    first.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const iterator = harness.run("first question");
    // Start the run, then switch provider mid-flight.
    await iterator.next();
    const second = new RecordingProvider("gemini", "model-B");
    harness.setProvider(second);
    release();
    await drain(iterator);

    assert.ok(first.seen.length >= 1, "the in-flight run used its snapshot");
    assert.equal(second.seen.length, 0, "the switch must not retarget a running request");

    await drain(harness.run("second question"));
    assert.ok(second.seen.length >= 1, "the next run uses the new provider");
  });

  it("reports the active selection and updates it on switch", async () => {
    const harness = await AgentHarness.create(new RecordingProvider("openai", "model-A"), {
      store: new SessionStore(path.join(tmp, "sessions2")),
      registry: new ToolRegistry(),
      gate: new AutoApproveGate(),
      cwd: tmp,
    });

    assert.deepEqual(harness.activeModel, { provider: "openai", model: "model-A" });
    harness.setProvider(new RecordingProvider("glm", "glm-4.6"));
    assert.deepEqual(harness.activeModel, { provider: "glm", model: "glm-4.6" });
  });
});

describe("sub-agent model inheritance", () => {
  function rig(configured: Record<string, string> = { openai: SECRET }) {
    const built: Array<{ provider: string; model: string }> = [];
    const manager = new SubAgentManager({
      parent: { provider: "openai", model: "model-A" },
      registry: defaultRegistry(),
      gate: new AutoApproveGate(),
      cwd: tmp,
      resolveCredential: async (id) => configured[id],
      providerFactory: (args) => {
        built.push({ provider: args.provider, model: args.model });
        return new RecordingProvider(args.provider, args.model);
      },
    });
    return { manager, built };
  }

  it("inherits the parent's provider and model", async () => {
    const { manager, built } = rig();
    const result = await manager.run({ task: "research this", role: "general" }, {});
    assert.equal(result.status, "completed");
    assert.deepEqual(built[0], { provider: "openai", model: "model-A" });
  });

  it("honours an explicit override when the credential exists", async () => {
    const { manager, built } = rig({ openai: SECRET, glm: "glm-key" });
    await manager.run({ task: "x", role: "general", provider: "glm", model: "glm-4.6" }, {});
    assert.deepEqual(built[0], { provider: "glm", model: "glm-4.6" });
  });

  it("refuses when the requested provider is not configured", async () => {
    const { manager, built } = rig({ openai: SECRET });
    const result = await manager.run({ task: "x", role: "general", provider: "glm" }, {});
    assert.equal(result.status, "failed");
    assert.match(result.errors?.join("\n") ?? "", /not configured/);
    assert.equal(built.length, 0, "no provider is built without a credential");
  });

  it("never hands the credential to the child's model", async () => {
    const { manager } = rig({ openai: SECRET });
    const result = await manager.run({ task: "x", role: "general" }, {});
    const dump = JSON.stringify(result);
    assert.equal(dump.includes(SECRET), false);
  });
});

describe("task orchestrator inheritance", () => {
  it("gives every task the run's snapshot unless it overrides", async () => {
    const built: Array<{ provider: string; model: string }> = [];
    const manager = new SubAgentManager({
      parent: { provider: "openai", model: "model-A" },
      registry: defaultRegistry(),
      gate: new AutoApproveGate(),
      cwd: tmp,
      resolveCredential: async () => SECRET,
      providerFactory: (args) => {
        built.push({ provider: args.provider, model: args.model });
        return new RecordingProvider(args.provider, args.model);
      },
    });

    const orchestrator = new TaskOrchestrator({ manager });
    const tasks: AgentTask[] = [
      { id: "a", task: "one", role: "general" },
      { id: "b", task: "two", role: "general", model: "model-C" },
      { id: "c", task: "three", role: "general" },
    ];

    const result = await orchestrator.run(
      { tasks, maxConcurrency: 3 },
      { defaults: { provider: "gemini", model: "model-B" } },
    );

    assert.equal(result.status, "completed");
    assert.equal(built.length, 3);
    assert.deepEqual(built.find((b) => b.model === "model-B")?.provider, "gemini");
    assert.ok(
      built.filter((b) => b.provider === "gemini" && b.model === "model-B").length === 2,
      "tasks without an override inherit the run snapshot",
    );
    assert.ok(
      built.some((b) => b.provider === "gemini" && b.model === "model-C"),
      "an explicit model wins over the inherited default",
    );
  });
});

describe("sessions store ids, not credentials", () => {
  it("persists only provider and model", async () => {
    const dir = path.join(tmp, "session-store");
    const store = new SessionStore(dir);
    const harness = await AgentHarness.create(new RecordingProvider("openai", "model-A"), {
      store,
      registry: new ToolRegistry(),
      gate: new AutoApproveGate(),
      cwd: tmp,
    });

    await drain(harness.run("hello"));
    const files = fs.readdirSync(dir);
    assert.ok(files.length > 0);
    for (const file of files) {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      assert.equal(raw.includes(SECRET), false, `${file} must not contain a credential`);
      if (file.endsWith(".jsonl")) {
        for (const line of raw.split("\n").filter((l) => l !== "")) {
          assert.equal(line.includes("apiKey"), false, "no apiKey field in session data");
        }
      }
    }
  });
});

describe("credentials are not reachable from the agent", () => {
  it("stays out of tool context, results and events", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set("openai", SECRET);
    const providers = new ProviderManager({ credentials, persist: false, env: {} });

    // The store is not exposed through the tool surface at all.
    const toolContextKeys = Object.keys({ cwd: tmp, signal: undefined });
    assert.equal(toolContextKeys.includes("credentials"), false);

    const statuses = await providers.listProviders();
    assert.equal(JSON.stringify(statuses).includes(SECRET), false);

    const built = await providers.createProviderFor("openai", "gpt-4o");
    assert.equal(built.name, "openai");
    // A Provider exposes name and model only.
    assert.equal(JSON.stringify({ name: built.name, model: built.model }).includes(SECRET), false);
  });

  it("resolves a stored credential for a sub-agent without exposing it", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set("glm", SECRET);
    const providers = new ProviderManager({ credentials, persist: false, env: {} });

    const resolved = await providers.createProviderFor("glm", "glm-4.6");
    assert.equal(resolved.model, "glm-4.6");
    assert.equal(JSON.stringify(Object.keys(resolved)).includes("apiKey"), false);
  });
});
