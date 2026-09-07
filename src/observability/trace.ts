import { newSpanId } from "./ids.js";

/**
 * Lightweight spans: run → agent → llm/tool, and task → sub-agent → llm/tool.
 *
 * Deliberately not OpenTelemetry — but shaped like it (spanId, parentSpanId,
 * monotonic start/end, status, metadata) so an exporter can be added later
 * without changing call sites.
 */

export type SpanStatus = "running" | "completed" | "failed" | "cancelled";

export interface Span {
  spanId: string;
  parentSpanId?: string;
  runId: string;
  name: string;
  /** Monotonic clock, so a wall-clock change cannot corrupt durations. */
  startMs: number;
  endMs?: number;
  status: SpanStatus;
  metadata?: Record<string, unknown>;
}

export interface StartSpanInput {
  runId: string;
  name: string;
  parentSpanId?: string;
  metadata?: Record<string, unknown>;
}

export class Tracer {
  #spans = new Map<string, Span>();

  start(input: StartSpanInput): Span {
    const span: Span = {
      spanId: newSpanId(),
      runId: input.runId,
      name: input.name,
      startMs: now(),
      status: "running",
      ...(input.parentSpanId !== undefined ? { parentSpanId: input.parentSpanId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    this.#spans.set(span.spanId, span);
    return span;
  }

  finish(span: Span, status: SpanStatus = "completed", metadata?: Record<string, unknown>): void {
    if (span.endMs !== undefined) return;
    span.endMs = now();
    span.status = status;
    if (metadata !== undefined) span.metadata = { ...span.metadata, ...metadata };
  }

  /** Elapsed milliseconds; undefined while the span is still running. */
  durationMs(span: Span): number | undefined {
    if (span.endMs === undefined) return undefined;
    return span.endMs - span.startMs;
  }

  childrenOf(spanId: string): Span[] {
    return [...this.#spans.values()].filter((s) => s.parentSpanId === spanId);
  }

  spansForRun(runId: string): Span[] {
    return [...this.#spans.values()].filter((s) => s.runId === runId);
  }

  roots(runId: string): Span[] {
    return this.spansForRun(runId).filter((s) => s.parentSpanId === undefined);
  }

  get size(): number {
    return this.#spans.size;
  }

  reset(): void {
    this.#spans.clear();
  }
}

export interface TraceNode {
  span: Span;
  durationMs: number | undefined;
  children: TraceNode[];
}

export function buildTrace(tracer: Tracer, runId: string): TraceNode[] {
  const build = (span: Span): TraceNode => ({
    span,
    durationMs: tracer.durationMs(span),
    children: tracer.childrenOf(span.spanId).map(build),
  });
  return tracer.roots(runId).map(build);
}

/** Indented tree for debug output — no payloads, only names and timings. */
export function formatTrace(nodes: TraceNode[], depth = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const duration =
      node.durationMs === undefined ? "running" : `${Math.round(node.durationMs)}ms`;
    lines.push(`${"  ".repeat(depth)}${node.span.name} [${node.span.status}] ${duration}`);
    lines.push(...formatTrace(node.children, depth + 1).split("\n").filter((l) => l !== ""));
  }
  return lines.join("\n");
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Start timing; returns a function that yields elapsed monotonic ms. */
export function startTimer(): () => number {
  const start = now();
  return () => now() - start;
}
