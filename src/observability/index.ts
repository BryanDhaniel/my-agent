import { EventBus } from "./bus.js";
import {
  childContext as makeChild,
  createEvent,
  type EventInput,
  type ExecutionContext,
  type ExecutionKind,
  type LogLevel,
  type ObservabilityEvent,
} from "./events.js";
import { newExecutionId, newRunId } from "./ids.js";
import { Logger } from "./logger.js";
import { METRIC, MetricsCollector } from "./metrics.js";
import { startTimer, Tracer, type SpanStatus } from "./trace.js";
import {
  addUsage,
  defaultPricing,
  estimateCost,
  type PricingRegistry,
  type TokenUsage,
  type UsageCost,
} from "./usage.js";

export * from "./bus.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./ids.js";
export * from "./logger.js";
export * from "./metrics.js";
export * from "./retry.js";
export * from "./trace.js";
export * from "./usage.js";

export interface ObservabilityOptions {
  level?: LogLevel;
  json?: boolean;
  write?: (line: string) => void;
  pricing?: PricingRegistry;
}

export interface SpanHandle {
  end(status?: SpanStatus, metadata?: Record<string, unknown>): number;
}

/**
 * The single entry point for observability.
 *
 * Emitters call `emit`/`span`/`recordUsage`; they never touch the logger,
 * metrics or tracer directly, so consumers can change without touching the
 * Agent. Every failure inside observability is contained — it must never
 * break a run.
 */
export class Observability {
  readonly bus = new EventBus();
  readonly metrics = new MetricsCollector();
  readonly tracer = new Tracer();
  readonly logger: Logger;
  readonly pricing: PricingRegistry;

  #usageByRun = new Map<string, TokenUsage>();

  constructor(options: ObservabilityOptions = {}) {
    this.logger = new Logger({
      ...(options.level !== undefined ? { level: options.level } : {}),
      ...(options.json !== undefined ? { json: options.json } : {}),
      ...(options.write !== undefined ? { write: options.write } : {}),
    });
    this.pricing = options.pricing ?? defaultPricing;

    this.bus.subscribe((event) => this.logger.logEvent(event));
  }

  /** Root execution context for a new run. */
  newRun(kind: ExecutionKind = "main-agent"): ExecutionContext {
    const runId = newRunId();
    return { runId, executionId: newExecutionId(kind), kind };
  }

  child(parent: ExecutionContext, kind: ExecutionKind): ExecutionContext {
    return makeChild(parent, kind);
  }

  emit(input: EventInput): ObservabilityEvent {
    const event = createEvent(input);
    this.bus.emit(event);
    return event;
  }

  /** Timed span; `end()` returns elapsed ms and records the duration event. */
  span(input: {
    context: ExecutionContext;
    name: string;
    metadata?: Record<string, unknown>;
  }): SpanHandle {
    const span = this.tracer.start({
      runId: input.context.runId,
      name: input.name,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
    const elapsed = startTimer();
    return {
      end: (status: SpanStatus = "completed", metadata?: Record<string, unknown>): number => {
        this.tracer.finish(span, status, metadata);
        return Math.round(elapsed());
      },
    };
  }

  /** Accumulate token usage for a run and feed the LLM metrics. */
  recordUsage(
    runId: string,
    usage: TokenUsage,
    pricing?: { provider?: string; model?: string },
  ): { usage: TokenUsage; cost: UsageCost } {
    const merged = addUsage(this.#usageByRun.get(runId) ?? {}, usage);
    this.#usageByRun.set(runId, merged);

    if (usage.inputTokens !== undefined) {
      this.metrics.increment(METRIC.llmInputTokens, usage.inputTokens);
    }
    if (usage.outputTokens !== undefined) {
      this.metrics.increment(METRIC.llmOutputTokens, usage.outputTokens);
    }
    const total = usage.totalTokens ?? merged.totalTokens;
    if (total !== undefined) this.metrics.increment(METRIC.llmTotalTokens, total);

    const cost = estimateCost(usage, pricing?.model !== undefined ? this.pricing.find(pricing.model) : undefined);
    return { usage: merged, cost };
  }

  usageFor(runId: string): TokenUsage {
    return this.#usageByRun.get(runId) ?? {};
  }

  costFor(runId: string, model?: string): UsageCost {
    return estimateCost(
      this.usageFor(runId),
      model !== undefined ? this.pricing.find(model) : undefined,
    );
  }

  reset(): void {
    this.metrics.reset();
    this.tracer.reset();
    this.#usageByRun.clear();
  }
}
