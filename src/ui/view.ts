import type { AgentEvent } from "../harness/events.js";

/**
 * Pure view state for the conversation surface. Everything the screen shows
 * about a Session is derived here from AgentEvents — no Ink, no React, no
 * side effects. The interface is: state in, new state out.
 */

export interface MessageView {
  kind: "message";
  role: "user" | "assistant";
  content: string;
}

export interface NoticeView {
  kind: "notice";
  text: string;
}

export interface ToolView {
  kind: "tool";
  callId: string;
  toolName: string;
  status: "running" | "done" | "denied";
  /** Short human summary of what was requested. */
  detail: string;
  /** Full Tool Result text, kept for verbose expansion. */
  output?: string;
}

/** One row of a rendered panel: a label, its detail, and an optional tag. */
export interface PanelRow {
  label: string;
  detail: string;
  tag?: string;
}

/**
 * A titled list — used by /skills, /help, and anything else that answers
 * "show me the set of X". Rendered as real rows, never as a dim blob,
 * so command output is actually readable.
 */
export interface PanelView {
  kind: "panel";
  title: string;
  rows: PanelRow[];
  /** Shown instead of rows when the set is empty. */
  emptyText?: string;
}

/** A single todo item. */
export interface TodoItem {
  label: string;
  status: "done" | "active" | "todo";
}

/** Task list, ported from claude-todo-list. */
export interface TodoView {
  kind: "todo";
  todos: TodoItem[];
}

/** One row of an inline edit hunk. */
export interface DiffLine {
  type: "add" | "del" | "ctx";
  n?: number;
  text: string;
}

/** Inline diff hunk, ported from claude-diff. */
export interface DiffView {
  kind: "diff";
  file: string;
  summary?: string;
  lines: DiffLine[];
}

/** Amber-colored warning, like the MCP authentication prompt. */
export interface WarningView {
  kind: "warning";
  text: string;
}

export type ViewEntry =
  | MessageView
  | NoticeView
  | ToolView
  | PanelView
  | TodoView
  | DiffView
  | WarningView;

export interface ChatViewState {
  entries: ViewEntry[];
  liveText: string;
  busy: boolean;
  error?: string;
  /**
   * Bumped whenever the transcript is replaced wholesale (/new, session
   * switch, delete). The UI uses it to remount the Static transcript so the
   * frozen output is rewritten instead of being appended to stale content.
   */
  transcriptGen: number;
}

export function initialViewState(): ChatViewState {
  return { entries: [], liveText: "", busy: false, transcriptGen: 0 };
}

export function reduceChatEvent(
  state: ChatViewState,
  event: AgentEvent,
): ChatViewState {
  switch (event.type) {
    case "user-message":
      return {
        ...state,
        entries: [
          ...state.entries,
          { kind: "message", role: "user", content: event.message.content },
        ],
      };

    case "text-delta":
      return { ...state, liveText: state.liveText + event.delta };

    case "assistant-message": {
      const hasTools =
        event.message.toolCalls !== undefined && event.message.toolCalls.length > 0;
      const visible = !hasTools || event.message.content.trim() !== "";
      return {
        ...state,
        liveText: "",
        entries: visible
          ? [
              ...state.entries,
              {
                kind: "message",
                role: "assistant",
                content: event.message.content,
              },
            ]
          : state.entries,
      };
    }

    case "tool-start":
      return {
        ...state,
        entries: [
          ...state.entries,
          {
            kind: "tool",
            callId: event.callId,
            toolName: event.toolName,
            status: "running" as const,
            detail: describeToolCall(event.toolName, event.argsJson),
          },
        ],
      };

    case "tool-denied":
      return updateTool(state, event.callId, (entry) => ({
        ...entry,
        status: "denied" as const,
        detail: `${entry.detail} · denied (${event.reason})`,
      }));

    case "tool-result":
      return updateTool(state, event.callId, (entry) => {
        // A blocked call still reports a result (the model must see why), but
        // it must not be presented as a success.
        const blocked = entry.status === "denied";
        return {
          ...entry,
          status: blocked ? ("denied" as const) : ("done" as const),
          detail: blocked
            ? entry.detail
            : `${entry.detail} · ${firstLineSummary(event.output)}`,
          output: event.output,
        };
      });

    case "error":
      return {
        ...state,
        error:
          event.error instanceof Error ? event.error.message : String(event.error),
      };

    // Memory / context lifecycle events carry no conversation content — they
    // surface as ghost notices so the user can see what the harness is doing
    // without them polluting the transcript.
    case "memory-recalled":
      return appendNotice(
        state,
        `memory · recalled ${plural(event.count, "memory", "memories")}`,
      );

    case "memory-stored":
      return appendNotice(
        state,
        `memory · saved ${plural(event.count, "memory", "memories")}`,
      );

    case "context-compacted":
      return appendNotice(
        state,
        `context compacted · ${plural(event.coveredMessages, "message", "messages")} summarized`,
      );

    case "todo-list":
      return {
        ...state,
        entries: [
          ...state.entries,
          { kind: "todo", todos: event.todos } as TodoView,
        ],
      };

    case "file-diff":
      return {
        ...state,
        entries: [
          ...state.entries,
          {
            kind: "diff",
            file: event.file,
            lines: event.lines,
            ...(event.summary !== undefined ? { summary: event.summary } : {}),
          } as DiffView,
        ],
      };

    default:
      return state;
  }
}

/** Local (non-Provider) message shown as a ghost notice line. */
export function appendNotice(state: ChatViewState, text: string): ChatViewState {
  return { ...state, entries: [...state.entries, { kind: "notice", text }] };
}

/** Append a titled panel — the surface every "list the X" command uses. */
export function appendPanel(
  state: ChatViewState,
  title: string,
  rows: PanelRow[],
  emptyText?: string,
): ChatViewState {
  return {
    ...state,
    entries: [
      ...state.entries,
      { kind: "panel", title, rows, ...(emptyText !== undefined ? { emptyText } : {}) },
    ],
  };
}

/** Append a task list — the ⎿ ✔/◼/◻ block used to track multi-step work. */
export function appendTodo(state: ChatViewState, todos: TodoItem[]): ChatViewState {
  return {
    ...state,
    entries: [...state.entries, { kind: "todo", todos }],
  };
}

/** Append an inline diff hunk — the +/- block used to show what changed. */
export function appendDiff(
  state: ChatViewState,
  file: string,
  lines: DiffLine[],
  summary?: string,
): ChatViewState {
  return {
    ...state,
    entries: [
      ...state.entries,
      {
        kind: "diff",
        file,
        lines,
        ...(summary !== undefined ? { summary } : {}),
      },
    ],
  };
}

/** Append an amber warning, like the MCP authentication prompt. */
export function appendWarning(state: ChatViewState, text: string): ChatViewState {
  return {
    ...state,
    entries: [...state.entries, { kind: "warning", text }],
  };
}

/** Replace the whole entry list — used by session replay and /new. */
export function replaceEntries(
  state: ChatViewState,
  entries: ViewEntry[],
): ChatViewState {
  return { ...state, entries, transcriptGen: state.transcriptGen + 1 };
}

export function setError(state: ChatViewState, message?: string): ChatViewState {
  return { ...state, error: message };
}

export function setBusy(state: ChatViewState, busy: boolean): ChatViewState {
  return { ...state, busy };
}

function plural(count: number, singular: string, many: string): string {
  return `${count} ${count === 1 ? singular : many}`;
}

function updateTool(
  state: ChatViewState,
  callId: string,
  patch: (entry: ToolView) => ToolView,
): ChatViewState {
  const index = state.entries.findLastIndex(
    (e) => e.kind === "tool" && e.callId === callId,
  );
  if (index === -1) return state;
  const entry = state.entries[index];
  if (entry?.kind !== "tool") return state;
  const entries = [...state.entries];
  entries[index] = patch(entry);
  return { ...state, entries };
}

/** One-line description of the requested action, from its JSON arguments. */
function describeToolCall(toolName: string, argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    const primary =
      parsed["path"] ?? parsed["command"] ?? parsed["pattern"] ?? undefined;
    if (typeof primary === "string") {
      return primary.length > 60 ? primary.slice(0, 57) + "…" : primary;
    }
    if (
      toolName === "edit_file" &&
      typeof parsed["path"] === "string" &&
      typeof parsed["oldText"] === "string"
    ) {
      return `${parsed["path"]}: "${parsed["oldText"].slice(0, 30)}…"`;
    }
    return JSON.stringify(parsed).slice(0, 60);
  } catch {
    return argsJson.slice(0, 60);
  }
}

function firstLineSummary(output: string): string {
  const firstLine = output.split("\n")[0] ?? "";
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine;
}
