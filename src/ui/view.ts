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

export type ViewEntry = MessageView | NoticeView | ToolView;

export interface ChatViewState {
  entries: ViewEntry[];
  liveText: string;
  busy: boolean;
  error?: string;
}

export function initialViewState(): ChatViewState {
  return { entries: [], liveText: "", busy: false };
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
      return updateTool(state, event.callId, (entry) => ({
        ...entry,
        status: "done" as const,
        detail: `${entry.detail} · ${firstLineSummary(event.output)}`,
        output: event.output,
      }));

    case "error":
      return {
        ...state,
        error:
          event.error instanceof Error ? event.error.message : String(event.error),
      };

    default:
      return state;
  }
}

/** Local (non-Provider) message shown as a ghost notice line. */
export function appendNotice(state: ChatViewState, text: string): ChatViewState {
  return { ...state, entries: [...state.entries, { kind: "notice", text }] };
}

/** Replace the whole entry list — used by session replay and /new. */
export function replaceEntries(
  state: ChatViewState,
  entries: ViewEntry[],
): ChatViewState {
  return { ...state, entries };
}

export function setError(state: ChatViewState, message?: string): ChatViewState {
  return { ...state, error: message };
}

export function setBusy(state: ChatViewState, busy: boolean): ChatViewState {
  return { ...state, busy };
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
