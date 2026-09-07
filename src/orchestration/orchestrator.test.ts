import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { defaultRegistry } from "../agent/tools/index.js";
import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import type { ProviderName } from "../config.js";
import { AutoApproveGate, DenyAllGate } from "../permissions/gate.js";
import type { Provider, StreamEvent } from "../providers/provider.js";
import { SubAgentManager } from "../subagent/manager.js";
import { validatePlan } from "./graph.js";
import { backoffMs, isRetryableError } from "./retry.js";
import { TaskOrchestrator } from "./orchestrator.js";
import type { AgentTask, OrchestrationEvent, TaskExecutionPlan } from "./types.js";

const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GLM_API_KEY"];
beforeAll(() => {
  for (const key of KEYS) process.env[key] = "test-key-not-real";
});
afterAll(() => {
  for (const key of KEYS) delete process.env[key];
});

interface Behavior {
  delayMs?: number;
  content?: string;
  status?: "completed" | "failed";
  error?: string;
}

interface Tracker {
  active: number;
  max: number;
}

class FakeProvider implements Provider {
  readonly name: string;
  readonly model: string;
  readonly seen: ChatMessage[][] = [];
  #resolver: (taskText: string) => Behavior;
  #tracker: Tracker;

  constructor(
    name: string,
    model: string,
    resolver: (taskText: string) => Behavior,
    tracker: Tracker,
  ) {
    this.name = name;
    this.model = model;
    this.#resolver = resolver;
    this.#tracker = tracker;
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    this.seen.push(messages);
    const taskText = messages
      .filter((m): m is Extract<ChatMessage, { role: "user" }> => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    const behavior = this.#resolver(taskText);

    this.#tracker.active++;
    this.#tracker.max = Math.max(this.#tracker.max, this.#tracker.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, behavior.delayMs ?? 5));
      if (behavior.status === "failed") {
        yield { type: "error", error: new Error(behavior.error ?? "boom") };
        return;
      }
      const message: AssistantMessage = {
        role: "assistant",
        content: behavior.content ?? "done",
      };
      yield { type: "text-delta", delta: message.content };
      yield { type: "done", message };
    } finally {
      this.#tracker.active--;
    }
  }
}

interface Rig {
  orchestrator: TaskOrchestrator;
  events: OrchestrationEvent[];
  tracker: Tracker;
  providers: FakeProvider[];
  seenFor: (needle: string) => string;
}

function rig(
  resolver: (taskText: string) => Behavior = () => ({}),
  options: { gate?: ConstructorParameters<typeof SubAgentManager>[0]["gate"] } = {},
): Rig {
  const tracker: Tracker = { active: 0, max: 0 };
  const events: OrchestrationEvent[] = [];
  const providers: FakeProvider[] = [];

  const manager = new SubAgentManager({
    parent: { provider: "openai", model: "gpt-4o-mini" },
    registry: defaultRegistry(),
    gate: options.gate ?? new AutoApproveGate(),
    cwd: process.cwd(),
    providerFactory: ({ provider, model }) => {
      const created = new FakeProvider(provider, model, resolver, tracker);
      providers.push(created);
      return created;
    },
  });

  const orchestrator = new TaskOrchestrator({
    manager,
    onEvent: (event) => events.push(event),
  });

  return {
    orchestrator,
    events,
    tracker,
    providers,
    seenFor: (needle: string): string => {
      for (const provider of providers) {
        for (const messages of provider.seen) {
          const text = messages.map((m) => m.content ?? "").join("\n");
          if (text.includes(needle)) return text;
        }
      }
      return "";
    },
  };
}

const task = (id: string, text: string, extra: Partial<AgentTask> = {}): AgentTask => ({
  id,
  task: text,
  ...extra,
});

describe("plan validation", () => {
  it("accepts a valid DAG", () => {
    const plan: TaskExecutionPlan = {
      tasks: [task("a", "A"), task("b", "B"), task("d", "D", { dependencies: ["a", "b"] })],
    };
    assert.equal(validatePlan(plan).ok, true);
  });

  it("rejects duplicate ids", () => {
    const result = validatePlan({ tasks: [task("a", "A"), task("a", "A2")] });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(), /duplicate task id "a"/);
  });

  it("rejects a missing dependency reference", () => {
    const result = validatePlan({ tasks: [task("a", "A", { dependencies: ["nope"] })] });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(), /unknown task "nope"/);
  });

  it("rejects a self dependency", () => {
    const result = validatePlan({ tasks: [task("a", "A", { dependencies: ["a"] })] });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(), /depends on itself/);
  });

  it("rejects a dependency cycle", () => {
    const result = validatePlan({
      tasks: [
        task("a", "A", { dependencies: ["c"] }),
        task("b", "B", { dependencies: ["a"] }),
        task("c", "C", { dependencies: ["b"] }),
      ],
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(), /dependency cycle/);
  });

  it("rejects an empty plan without starting anything", async () => {
    const { orchestrator } = rig();
    const result = await orchestrator.run({ tasks: [] });
    assert.equal(result.status, "failed");
    assert.match(result.summary ?? "", /rejected/);
    assert.equal(result.tasks.length, 0);
  });
});

describe("scheduling", () => {
  it("runs independent tasks and unlocks dependents afterwards", async () => {
    const { orchestrator, events } = rig();
    const result = await orchestrator.run({
      tasks: [task("a", "A"), task("b", "B"), task("d", "D", { dependencies: ["a", "b"] })],
    });

    assert.equal(result.status, "completed");
    const started = events
      .filter((e): e is Extract<OrchestrationEvent, { type: "task.started" }> => e.type === "task.started")
      .map((e) => e.taskId);
    assert.ok(started.indexOf("a") < started.indexOf("d"));
    assert.ok(started.indexOf("b") < started.indexOf("d"));
  });

  it("never exceeds maxConcurrency", async () => {
    const { orchestrator, tracker } = rig(() => ({ delayMs: 40 }));
    const result = await orchestrator.run({
      tasks: ["a", "b", "c", "d", "e"].map((id) => task(id, `T-${id}`)),
      maxConcurrency: 2,
    });

    assert.equal(result.status, "completed");
    assert.ok(tracker.max <= 2, `observed ${tracker.max} concurrent sub-agents`);
    assert.equal(tracker.max, 2, "expected the concurrency limit to actually be reached");
  });

  it("clamps an oversized maxConcurrency", async () => {
    const { orchestrator, tracker } = rig(() => ({ delayMs: 30 }));
    await orchestrator.run({
      tasks: ["a", "b", "c", "d"].map((id) => task(id, `T-${id}`)),
      maxConcurrency: 100,
    });
    assert.ok(tracker.max <= 8, `observed ${tracker.max}`);
  });
});

describe("failure handling", () => {
  it("skips dependents of a failed task", async () => {
    const { orchestrator } = rig((text) =>
      text.includes("TASK-A") ? { status: "failed", error: "boom" } : {},
    );
    const result = await orchestrator.run({
      tasks: [task("a", "TASK-A"), task("d", "TASK-D", { dependencies: ["a"] })],
    });

    assert.equal(result.tasks[0]?.status, "failed");
    assert.equal(result.tasks[1]?.status, "skipped");
    assert.match(result.tasks[1]?.error ?? "", /dependency did not complete/);
    assert.equal(result.status, "failed");
  });

  it("continue lets independent tasks finish despite a failure", async () => {
    const { orchestrator } = rig((text) =>
      text.includes("TASK-A") ? { status: "failed", error: "boom" } : {},
    );
    const result = await orchestrator.run({
      tasks: [task("a", "TASK-A"), task("b", "TASK-B")],
      failureStrategy: "continue",
    });

    assert.equal(result.status, "partial");
    assert.equal(result.tasks[0]?.status, "failed");
    assert.equal(result.tasks[1]?.status, "completed");
  });

  it("fail-fast stops scheduling further tasks", async () => {
    const { orchestrator } = rig((text) =>
      text.includes("TASK-A") ? { status: "failed", error: "boom" } : { delayMs: 5 },
    );
    const result = await orchestrator.run({
      tasks: [task("a", "TASK-A"), task("b", "TASK-B"), task("c", "TASK-C")],
      failureStrategy: "fail-fast",
      maxConcurrency: 1,
    });

    assert.equal(result.tasks[0]?.status, "failed");
    assert.equal(result.tasks[1]?.status, "cancelled");
    assert.equal(result.tasks[2]?.status, "cancelled");
  });

  it("does not bypass the permission gate", async () => {
    const { orchestrator } = rig(() => ({}), { gate: new DenyAllGate() });
    // A coder task reaching a mutating tool must still be denied; the plan
    // itself only fails because the child cannot complete its work.
    const result = await orchestrator.run({
      tasks: [task("a", "TASK-A", { role: "researcher" })],
    });
    assert.equal(result.status, "completed");
  });
});

describe("retry", () => {
  it("classifies transient vs permanent failures", () => {
    assert.equal(isRetryableError("rate limit exceeded"), true);
    assert.equal(isRetryableError("request timed out"), true);
    assert.equal(isRetryableError("permission denied"), false);
    assert.equal(isRetryableError('unknown tool "x"'), false);
  });

  it("backs off exponentially with a ceiling", () => {
    assert.equal(backoffMs(1), 1_000);
    assert.equal(backoffMs(3), 4_000);
    assert.equal(backoffMs(20), 8_000);
  });

  it("retries a transient failure then succeeds", async () => {
    let calls = 0;
    const { orchestrator } = rig((text) => {
      if (!text.includes("TASK-A")) return {};
      calls++;
      return calls === 1 ? { status: "failed", error: "rate limit exceeded" } : {};
    });

    const result = await orchestrator.run({
      tasks: [task("a", "TASK-A", { maxRetries: 1 })],
    });

    assert.equal(result.status, "completed");
    assert.equal(result.tasks[0]?.attempts, 2);
  });

  it("does not retry a permanent failure", async () => {
    const { orchestrator } = rig(() => ({ status: "failed", error: "permission denied" }));
    const result = await orchestrator.run({
      tasks: [task("a", "TASK-A", { maxRetries: 3 })],
    });
    assert.equal(result.tasks[0]?.status, "failed");
    assert.equal(result.tasks[0]?.attempts, 1);
  });

  it("respects maxRetries", async () => {
    const { orchestrator } = rig(() => ({ status: "failed", error: "temporarily unavailable" }));
    const result = await orchestrator.run({
      tasks: [task("a", "TASK-A", { maxRetries: 2 })],
    });
    assert.equal(result.tasks[0]?.attempts, 3);
    assert.equal(result.tasks[0]?.status, "failed");
  });
});

describe("cancellation and timeout", () => {
  it("cancels everything when the caller aborts", async () => {
    const { orchestrator } = rig(() => ({ delayMs: 200 }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await orchestrator.run(
      { tasks: [task("a", "TASK-A"), task("b", "TASK-B")], maxConcurrency: 1 },
      { signal: controller.signal },
    );

    assert.equal(result.status, "cancelled");
    assert.ok(result.tasks.every((t) => t.status === "cancelled"));
  });

  it("orchestrator.cancel() marks pending tasks cancelled", async () => {
    const { orchestrator } = rig(() => ({ delayMs: 150 }));
    const promise = orchestrator.run({
      tasks: [task("a", "TASK-A"), task("b", "TASK-B"), task("c", "TASK-C")],
      maxConcurrency: 1,
    });
    setTimeout(() => orchestrator.cancel(), 20);
    const result = await promise;

    assert.equal(result.status, "cancelled");
    assert.ok(result.tasks.some((t) => t.status === "cancelled"));
  });

  it("times out the whole plan", async () => {
    const { orchestrator } = rig(() => ({ delayMs: 300 }));
    const result = await orchestrator.run({
      tasks: [task("a", "TASK-A")],
      timeoutMs: 40,
    });
    assert.equal(result.status, "cancelled");
    assert.match(result.tasks[0]?.error ?? "", /timed out/);
  });
});

describe("aggregation and isolation", () => {
  it("produces a concise summary with no transcripts", async () => {
    const { orchestrator } = rig((text) => ({
      content: text.includes("TASK-A") ? "found auth flow" : "found 3 outdated packages",
    }));
    const result = await orchestrator.run({
      tasks: [task("a", "TASK-A"), task("b", "TASK-B")],
    });

    assert.match(result.summary ?? "", /orchestration completed/);
    assert.match(result.summary ?? "", /a: completed/);
    assert.match(result.summary ?? "", /found auth flow/);
    assert.ok((result.summary ?? "").length < 2_000, "summary should stay concise");
  });

  it("keeps sibling task contexts separate", async () => {
    const { orchestrator, seenFor } = rig((text) => ({ content: `result for ${text.slice(0, 6)}` }));
    await orchestrator.run({
      tasks: [task("a", "MARKER-AAA"), task("b", "MARKER-BBB")],
    });

    const aContext = seenFor("MARKER-AAA");
    const bContext = seenFor("MARKER-BBB");
    assert.ok(aContext.includes("MARKER-AAA"));
    assert.ok(!aContext.includes("MARKER-BBB"), "task A must not see task B's task text");
    assert.ok(!bContext.includes("MARKER-AAA"), "task B must not see task A's task text");
  });

  it("hands dependents only selected dependency results", async () => {
    const { orchestrator, seenFor } = rig((text) => ({
      content: text.includes("TASK-A") ? "AUTH-SUMMARY-123" : "reviewed",
    }));
    await orchestrator.run({
      tasks: [task("a", "TASK-A"), task("d", "TASK-D", { dependencies: ["a"] })],
    });

    const dContext = seenFor("TASK-D");
    assert.ok(dContext.includes("AUTH-SUMMARY-123"), "dependent should receive A's summary");
    assert.ok(dContext.includes("## a"), "dependency results should be labelled by task id");
  });

  it("passes provider and model overrides through to the manager", async () => {
    const built: Array<{ provider: ProviderName; model: string }> = [];
    const tracker: Tracker = { active: 0, max: 0 };
    const manager = new SubAgentManager({
      parent: { provider: "openai", model: "gpt-4o-mini" },
      registry: defaultRegistry(),
      gate: new AutoApproveGate(),
      cwd: process.cwd(),
      providerFactory: ({ provider, model }) => {
        built.push({ provider, model });
        return new FakeProvider(provider, model, () => ({}), tracker);
      },
    });
    const orchestrator = new TaskOrchestrator({ manager });

    await orchestrator.run({
      tasks: [
        task("a", "TASK-A"),
        task("b", "TASK-B", { provider: "gemini", model: "gemini-2.5-pro" }),
      ],
      maxConcurrency: 1,
    });

    assert.deepEqual(built, [
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "gemini", model: "gemini-2.5-pro" },
    ]);
  });
});
