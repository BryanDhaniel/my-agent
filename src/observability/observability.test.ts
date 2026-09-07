import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { EventBus } from "./bus.js";
import { AgentError, classifyError, isCancellation, isRetryableError } from "./errors.js";
import { childContext, createEvent, type ExecutionContext } from "./events.js";
import { newEventId, newExecutionId, newRunId, newSpanId } from "./ids.js";
import { Logger, sanitizeFields } from "./logger.js";
import { METRIC, MetricsCollector } from "./metrics.js";
import { backoffMs, defaultRetryPolicy, delay, withRetry } from "./retry.js";
import { buildTrace, formatTrace, startTimer, Tracer } from "./trace.js";
import { addUsage, estimateCost, formatCost, PricingRegistry } from "./usage.js";
import { Observability } from "./index.js";

/**
 * A real-looking credential, assembled at runtime so the committed source
 * never contains a complete token (the same rule the memory sanitizer tests
 * follow).
 */
const fakeGithubToken = ["ghp_", "abcdefghijklmnopqrstuvwxyz1234"].join("");

const ctx = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  runId: newRunId(),
  executionId: newExecutionId("main-agent"),
  kind: "main-agent",
  ...overrides,
});

describe("ids", () => {
  it("generates unique run ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRunId()));
    assert.equal(ids.size, 200);
  });

  it("does not rely on timestamps alone", () => {
    // Two ids minted back-to-back in the same millisecond must still differ,
    // and the id must not be a bare timestamp.
    assert.notEqual(newRunId(), newRunId());
    assert.ok(!/^run_\d+$/.test(newRunId()), "id should not be a bare timestamp");
    assert.notEqual(newSpanId(), newEventId());
  });
});

describe("events", () => {
  it("carries the execution tree and a timestamp", () => {
    const context = ctx({ parentExecutionId: "exec_parent" });
    const event = createEvent({ type: "tool.started", context });
    assert.equal(event.runId, context.runId);
    assert.equal(event.executionId, context.executionId);
    assert.equal(event.parentExecutionId, "exec_parent");
    assert.ok(!Number.isNaN(Date.parse(event.timestamp)));
  });

  it("derives a sensible level from the event type", () => {
    assert.equal(createEvent({ type: "llm.request.failed", context: ctx() }).level, "error");
    assert.equal(createEvent({ type: "permission.denied", context: ctx() }).level, "warn");
    assert.equal(createEvent({ type: "run.started", context: ctx() }).level, "info");
  });

  it("links children to their parent within the same run", () => {
    const parent = ctx();
    const child = childContext(parent, "sub-agent");
    assert.equal(child.runId, parent.runId);
    assert.equal(child.parentExecutionId, parent.executionId);
    assert.equal(child.kind, "sub-agent");
  });
});

describe("EventBus", () => {
  it("delivers events to subscribers in order", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));
    bus.emit(createEvent({ type: "run.started", context: ctx() }));
    bus.emit(createEvent({ type: "run.completed", context: ctx() }));
    assert.deepEqual(seen, ["run.started", "run.completed"]);
  });

  it("isolates subscribers by run id", () => {
    const bus = new EventBus();
    const a = ctx();
    const b = ctx();
    const seenA: string[] = [];
    bus.subscribeToRun(a.runId, (e) => seenA.push(e.type));

    bus.emit(createEvent({ type: "run.started", context: b }));
    bus.emit(createEvent({ type: "run.started", context: a }));

    assert.equal(seenA.length, 1);
  });

  it("contains listener failures", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    bus.subscribe((e) => seen.push(e.type));
    bus.emit(createEvent({ type: "run.started", context: ctx() }));
    assert.equal(seen.length, 1, "a throwing listener must not stop delivery");
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.subscribe(() => count++);
    bus.emit(createEvent({ type: "run.started", context: ctx() }));
    off();
    bus.emit(createEvent({ type: "run.started", context: ctx() }));
    assert.equal(count, 1);
  });
});

describe("error classification", () => {
  it("classifies network failures as retryable", () => {
    const error = classifyError(new Error("ECONNRESET socket closed"));
    assert.equal(error.kind, "network");
    assert.equal(error.retryable, true);
  });

  it("classifies rate limits as retryable", () => {
    assert.equal(classifyError(new Error("rate limit exceeded")).kind, "rate_limit");
    assert.equal(isRetryableError("429 too many requests"), true);
  });

  it("never retries authentication failures", () => {
    const error = classifyError(new Error("401 invalid api key"));
    assert.equal(error.kind, "authentication");
    assert.equal(error.retryable, false);
  });

  it("never retries permission or invalid-request failures", () => {
    assert.equal(classifyError(new Error("permission denied")).retryable, false);
    assert.equal(classifyError(new Error("invalid arguments")).retryable, false);
  });

  it("classifies timeouts as retryable", () => {
    assert.equal(classifyError(new Error("request timed out")).kind, "timeout");
    assert.equal(isRetryableError("timed out"), true);
  });

  it("recognises cancellation", () => {
    assert.equal(classifyError(new Error("The operation was aborted")).kind, "cancellation");
    assert.equal(isCancellation("aborted"), true);
    assert.equal(isRetryableError("aborted"), false);
  });

  it("prefers HTTP status codes when present", () => {
    assert.equal(classifyError({ status: 429, message: "nope" }).kind, "rate_limit");
    assert.equal(classifyError({ status: 503, message: "nope" }).kind, "model_unavailable");
    assert.equal(classifyError({ status: 500, message: "nope" }).kind, "network");
  });

  it("falls back to internal for unknown errors", () => {
    assert.equal(classifyError(new Error("something odd")).kind, "internal");
  });

  it("passes an existing AgentError through untouched", () => {
    const original = new AgentError({ kind: "tool", message: "boom" });
    assert.equal(classifyError(original), original);
  });
});

describe("retry", () => {
  it("backs off exponentially with a ceiling", () => {
    assert.equal(backoffMs(1), 1_000);
    assert.equal(backoffMs(3), 4_000);
    assert.equal(backoffMs(50), 8_000);
  });

  it("retries a transient failure and reports each attempt", () => {
    let calls = 0;
    const retries: number[] = [];
    const result = withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("rate limit exceeded");
        return "ok";
      },
      { onRetry: (info) => retries.push(info.attempt) },
    );
    assert.equal(result instanceof Promise, true);
    return result.then((value) => {
      assert.equal(value, "ok");
      assert.deepEqual(retries, [2, 3]);
    });
  });

  it("does not retry a permanent failure", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new Error("permission denied");
      }),
    );
    assert.equal(calls, 1);
  });

  it("respects maxRetries", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error("temporarily unavailable");
        },
        { policy: { ...defaultRetryPolicy, maxRetries: 2, getDelay: () => 1 } },
      ),
    );
    assert.equal(calls, 3);
  });

  it("stops retrying when cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls++;
        controller.abort();
        throw new Error("rate limit exceeded");
      },
      { signal: controller.signal, policy: { ...defaultRetryPolicy, getDelay: () => 5 } },
    );
    await assert.rejects(promise);
    assert.equal(calls, 1);
  });

  it("delay resolves early on abort", async () => {
    const controller = new AbortController();
    const promise = delay(10_000, controller.signal);
    controller.abort();
    await promise; // would hang for 10s if cancellation were ignored
  });
});

describe("metrics", () => {
  it("counts, observes and sets", () => {
    const metrics = new MetricsCollector();
    metrics.increment(METRIC.llmRequestsTotal);
    metrics.increment(METRIC.llmRequestsTotal, 2);
    metrics.observe(METRIC.llmRequestDurationMs, 100);
    metrics.observe(METRIC.llmRequestDurationMs, 300);
    metrics.set("active_subagents", 3);

    assert.equal(metrics.counter(METRIC.llmRequestsTotal), 3);
    assert.equal(metrics.gauge("active_subagents"), 3);
    const stats = metrics.stats(METRIC.llmRequestDurationMs);
    assert.equal(stats?.count, 2);
    assert.equal(stats?.min, 100);
    assert.equal(stats?.max, 300);
    assert.equal(stats?.avg, 200);
  });

  it("snapshots everything", () => {
    const metrics = new MetricsCollector();
    metrics.increment(METRIC.toolCallsTotal);
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.counters[METRIC.toolCallsTotal], 1);
    assert.equal(Object.keys(snapshot.observations).length, 0);
  });

  it("bounds observation memory", () => {
    const metrics = new MetricsCollector();
    for (let i = 0; i < 2_000; i++) metrics.observe("x", i);
    assert.equal(metrics.stats("x")?.count, 1_000);
  });
});

describe("tracing", () => {
  it("builds a parent/child tree", () => {
    const tracer = new Tracer();
    const runId = newRunId();
    const root = tracer.start({ runId, name: "run" });
    const task = tracer.start({ runId, name: "task", parentSpanId: root.spanId });
    const sub = tracer.start({ runId, name: "sub-agent", parentSpanId: task.spanId });
    tracer.finish(sub);
    tracer.finish(task);
    tracer.finish(root);

    const tree = buildTrace(tracer, runId);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.children[0]?.children[0]?.span.name, "sub-agent");
    assert.ok((tree[0]?.durationMs ?? 0) >= 0);
  });

  it("measures duration monotonically", () => {
    const elapsed = startTimer();
    const done = Math.round(elapsed());
    assert.ok(done >= 0 && done < 5_000);
  });

  it("formats a readable tree", () => {
    const tracer = new Tracer();
    const runId = newRunId();
    const a = tracer.start({ runId, name: "run" });
    const b = tracer.start({ runId, name: "tool", parentSpanId: a.spanId });
    tracer.finish(b, "completed");
    tracer.finish(a, "completed");
    const text = formatTrace(buildTrace(tracer, runId));
    assert.match(text, /run \[completed\]/);
    assert.match(text, /tool \[completed\]/);
  });

  it("marks unfinished spans as running", () => {
    const tracer = new Tracer();
    const span = tracer.start({ runId: newRunId(), name: "llm" });
    assert.equal(tracer.durationMs(span), undefined);
    assert.equal(span.status, "running");
  });
});

describe("usage and cost", () => {
  it("accumulates usage across calls", () => {
    const total = addUsage({ inputTokens: 100, outputTokens: 50 }, { inputTokens: 20 });
    assert.equal(total.inputTokens, 120);
    assert.equal(total.outputTokens, 50);
    assert.equal(total.totalTokens, 170);
  });

  it("reports cost as unknown when pricing is missing", () => {
    const cost = estimateCost({ inputTokens: 1_000 }, new PricingRegistry().find("whatever"));
    assert.equal(cost.totalCost, undefined);
    assert.equal(formatCost(cost), "unknown");
  });

  it("computes cost when pricing is registered", () => {
    const pricing = new PricingRegistry();
    pricing.register("gpt-4o", { inputPerMTok: 5, outputPerMTok: 15, currency: "USD" });
    const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, pricing.find("gpt-4o"));
    assert.equal(cost.inputCost, 5);
    assert.equal(cost.outputCost, 15);
    assert.equal(cost.totalCost, 20);
    assert.equal(formatCost(cost), "20.0000 USD");
  });

  it("matches by model prefix", () => {
    const pricing = new PricingRegistry();
    pricing.register("gpt-4o", { inputPerMTok: 5, outputPerMTok: 15, currency: "USD" });
    assert.ok(pricing.find("gpt-4o-mini") !== undefined);
  });
});

describe("logging safety", () => {
  it("redacts forbidden keys entirely", () => {
    const out = sanitizeFields({ apiKey: "anything", authorization: "Bearer x", note: "ok" });
    assert.equal(out["apiKey"], "[redacted]");
    assert.equal(out["authorization"], "[redacted]");
    assert.equal(out["note"], "ok");
  });

  it("never writes a credential to the log line", () => {
    const lines: string[] = [];
    const logger = new Logger({ level: "debug", write: (l) => lines.push(l) });
    logger.info("llm.request.completed", {
      apiKey: fakeGithubToken,
      authorization: `Bearer ${fakeGithubToken}`,
      note: `token is ${fakeGithubToken}`,
    });
    const output = lines.join("\n");
    assert.ok(!output.includes(fakeGithubToken), "credential leaked into logs");
    assert.ok(output.includes("[redacted]"));
  });

  it("honours log levels", () => {
    const lines: string[] = [];
    const logger = new Logger({ level: "warn", write: (l) => lines.push(l) });
    logger.debug("d", {});
    logger.info("i", {});
    logger.warn("w", {});
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /w/);
  });

  it("emits JSON when configured", () => {
    const lines: string[] = [];
    const logger = new Logger({ level: "info", json: true, write: (l) => lines.push(l) });
    logger.info("run.completed", { runId: "run_1" });
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(parsed["event"], "run.completed");
    assert.equal(parsed["runId"], "run_1");
  });
});

describe("Observability facade", () => {
  it("ties events, metrics, traces and usage to one run", () => {
    const lines: string[] = [];
    const obs = new Observability({ level: "error", write: (l) => lines.push(l) });
    const run = obs.newRun();
    const task = obs.child(run, "task");

    assert.notEqual(run.runId, task.runId === run.runId ? "" : "");
    assert.equal(task.runId, run.runId);

    obs.emit({ type: "run.started", context: run });
    const handle = obs.span({ context: task, name: "task" });
    const duration = handle.end("completed");

    obs.recordUsage(run.runId, { inputTokens: 10, outputTokens: 5 });
    obs.recordUsage(run.runId, { inputTokens: 5 });

    assert.ok(duration >= 0);
    assert.equal(obs.usageFor(run.runId).inputTokens, 15);
    assert.equal(obs.metrics.counter(METRIC.llmInputTokens), 15);
    assert.equal(obs.tracer.spansForRun(run.runId).length, 1);
  });

  it("reconstructs a full execution tree", () => {
    const obs = new Observability({ level: "error", write: () => {} });
    const run = obs.newRun();
    const root = obs.tracer.start({ runId: run.runId, name: "run" });

    for (const taskName of ["security-review", "dependency-review"]) {
      const task = obs.child(run, "task");
      const taskSpan = obs.tracer.start({
        runId: run.runId,
        name: taskName,
        parentSpanId: root.spanId,
      });
      obs.emit({ type: "task.started", context: task, metadata: { taskId: taskName } });

      const sub = obs.child(task, "sub-agent");
      const subSpan = obs.tracer.start({
        runId: run.runId,
        name: "sub-agent",
        parentSpanId: taskSpan.spanId,
      });
      obs.emit({ type: "subagent.started", context: sub });

      obs.tracer.finish(subSpan);
      obs.emit({ type: "subagent.completed", context: sub });
      obs.tracer.finish(taskSpan);
    }
    obs.tracer.finish(root);

    const tree = buildTrace(obs.tracer, run.runId);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.children.length, 2, "both tasks should be under the run");
    assert.equal(tree[0]?.children[0]?.children[0]?.span.name, "sub-agent");
    assert.equal(formatTrace(tree).split("\n").length, 5);
  });
});
