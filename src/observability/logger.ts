import { redactSecrets } from "../memory/sanitize.js";
import type { LogLevel, ObservabilityEvent } from "./events.js";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values must never reach a log, whatever they contain. */
const FORBIDDEN_KEY = /key|token|secret|password|passwd|authorization|credential|cookie|bearer/i;

export interface LogFields {
  runId?: string;
  executionId?: string;
  parentExecutionId?: string;
  component?: string;
  provider?: string;
  model?: string;
  taskId?: string;
  toolName?: string;
  durationMs?: number;
  errorCode?: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Machine-readable one-line JSON, for piping into other tools. */
  json?: boolean;
  write?: (line: string) => void;
}

/**
 * Structured logger. Safe by default: values are redacted with the existing
 * memory sanitizer, and known-sensitive keys are dropped outright.
 *
 * Normal runs stay quiet (info), so the terminal is not flooded; debug mode
 * turns on per-step detail.
 */
export class Logger {
  #level: LogLevel;
  #json: boolean;
  #write: (line: string) => void;

  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? "info";
    this.#json = options.json ?? false;
    this.#write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
  }

  get level(): LogLevel {
    return this.#level;
  }

  setLevel(level: LogLevel): void {
    this.#level = level;
  }

  debug(event: string, fields: LogFields = {}): void {
    this.#log("debug", event, fields);
  }
  info(event: string, fields: LogFields = {}): void {
    this.#log("info", event, fields);
  }
  warn(event: string, fields: LogFields = {}): void {
    this.#log("warn", event, fields);
  }
  error(event: string, fields: LogFields = {}): void {
    this.#log("error", event, fields);
  }

  /** Render an observability event as a log line, preserving its level. */
  logEvent(event: ObservabilityEvent): void {
    this.#log(event.level, event.type, {
      runId: event.runId,
      executionId: event.executionId,
      ...(event.parentExecutionId !== undefined
        ? { parentExecutionId: event.parentExecutionId }
        : {}),
      ...safeMetadata(event.metadata),
    });
  }

  #log(level: LogLevel, event: string, fields: LogFields): void {
    if (ORDER[level] < ORDER[this.#level]) return;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...sanitizeFields(fields),
    };
    this.#write(
      this.#json
        ? JSON.stringify(record)
        : `${record.timestamp} ${level.toUpperCase().padEnd(5)} ${event} ${formatRest(record)}`,
    );
  }
}

function formatRest(record: Record<string, unknown>): string {
  const { timestamp: _t, level: _l, event: _e, ...rest } = record;
  const parts = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.length > 0 ? parts.join(" ") : "";
}

/** Drop forbidden keys; redact everything else that is a string. */
export function sanitizeFields(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (FORBIDDEN_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactValue(value);
  }
  return out;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return redactSecrets(value.message);
  // Unknown shapes are stringified so a secret cannot hide inside an object.
  return redactSecrets(safeStringify(value));
}

function safeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (metadata === undefined) return {};
  return sanitizeFields(metadata as LogFields);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
