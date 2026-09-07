import type { ObservabilityEvent } from "./events.js";

export type EventListener = (event: ObservabilityEvent) => void;

/**
 * Minimal internal event bus.
 *
 * Emitters do not know their consumers: the TUI, logger, metrics and trace
 * collector all subscribe the same way. Subscription is scoped to a run so a
 * listener can follow one execution without filtering every event itself.
 *
 * Listener errors are swallowed — observability must never take down a run.
 */
export class EventBus {
  #listeners = new Set<EventListener>();
  #byRun = new Map<string, Set<EventListener>>();

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  subscribeToRun(runId: string, listener: EventListener): () => void {
    const set = this.#byRun.get(runId) ?? new Set<EventListener>();
    set.add(listener);
    this.#byRun.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#byRun.delete(runId);
    };
  }

  emit(event: ObservabilityEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Observability failures must never break execution.
      }
    }
    for (const listener of this.#byRun.get(event.runId) ?? []) {
      try {
        listener(event);
      } catch {
        // ignore
      }
    }
  }

  get listenerCount(): number {
    return this.#listeners.size + [...this.#byRun.values()].reduce((n, s) => n + s.size, 0);
  }
}
