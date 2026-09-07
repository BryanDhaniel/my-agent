import { randomUUID } from "node:crypto";

/**
 * Stable identifiers for the execution tree.
 *
 * IDs are UUID-based rather than timestamp-based: a timestamp alone is not
 * unique under parallelism, and two sub-agents starting in the same
 * millisecond would collide.
 */

export type RunId = string;

export function newRunId(): RunId {
  return `run_${randomUUID()}`;
}

export function newExecutionId(kind: string): string {
  return `exec_${kind}_${randomUUID().slice(0, 8)}`;
}

export function newSpanId(): string {
  return `span_${randomUUID().slice(0, 8)}`;
}

export function newEventId(): string {
  return `evt_${randomUUID().slice(0, 8)}`;
}
