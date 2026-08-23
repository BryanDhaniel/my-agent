import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import TextInput from "ink-text-input";
import type { ChatEvent, ChatService } from "../agent/chat.js";
import type { PermissionRequest, UiGate } from "../permissions/gate.js";
import type { LoadedSession, SessionStore } from "../session/store.js";
import { MarkdownLite } from "./markdown.js";
import { SessionBrowser } from "./session-browser.js";
import { suggestCommands } from "./commands.js";
import type { ChatMessage } from "../agent/types.js";

const DOTS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function ToolLine({ entry }: { entry: Extract<Entry, { kind: "tool" }> }): React.ReactElement {
  const [icon, color] =
    entry.status === "done"
      ? ["✓", "green"]
      : entry.status === "denied"
        ? ["✗", "red"]
        : ["⚙", "yellow"];
  return (
    <Text>
      {"  "}
      <Text color={color}>{icon} </Text>
      <Text dimColor>
        {entry.toolName} — {entry.detail}
        {entry.status === "running" ? "…" : ""}
      </Text>
    </Text>
  );
}

function DotsSpinner({ label }: { label: string }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % DOTS.length), 80);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text>
      <Text color="cyan">{DOTS[frame]}</Text> {label}
    </Text>
  );
}

type Entry =
  | { kind: "message"; role: "user" | "assistant"; content: string }
  | { kind: "notice"; text: string }
  | {
      kind: "tool";
      callId: string;
      toolName: string;
      status: "running" | "done" | "denied";
      detail: string;
    };

interface BrowserState {
  sessions: LoadedSession[];
  selected: number;
}

export function App({
  service,
  gate,
  store,
}: {
  service: ChatService;
  gate: UiGate;
  store: SessionStore;
}): React.ReactElement {
  const { exit } = useApp();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [liveText, setLiveText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<PermissionRequest[]>([]);
  const [allowedRules, setAllowedRules] = useState<readonly string[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [browser, setBrowser] = useState<BrowserState | undefined>();
  const abortRef = useRef<AbortController | undefined>(undefined);

  const suggestions = suggestCommands(value);

  useEffect(() => {
    gate.onPendingChange((p) => {
      setPending(p);
      setAllowedRules(gate.allowedRules);
    });
    return () => gate.onPendingChange(() => {});
  }, [gate]);

  useEffect(() => setSelectedSuggestion(0), [value]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      abortRef.current?.abort();
      exit();
      return;
    }

    if (browser !== undefined) {
      if (key.upArrow) {
        setBrowser((b) =>
          b === undefined ? b : { ...b, selected: Math.max(0, b.selected - 1) },
        );
      } else if (key.downArrow) {
        setBrowser((b) =>
          b === undefined
            ? b
            : { ...b, selected: Math.min(b.sessions.length - 1, b.selected + 1) },
        );
      } else if (input === "s") {
        void switchToSession(browser);
      } else if (input === "d") {
        void deleteSession(browser);
      } else if (key.escape || input === "q") {
        setBrowser(undefined);
      }
      return;
    }

    const currentRequest = pending[0];
    if (currentRequest) {
      if (input === "y") gate.respond(currentRequest.id, "once");
      if (input === "n") gate.respond(currentRequest.id, "deny");
      if (input === "a" && currentRequest.ruleKey !== undefined) {
        gate.respond(currentRequest.id, "always");
        setEntries((prev) => [
          ...prev,
          {
            kind: "notice",
            text: `always allowing ${currentRequest.toolName} · ${currentRequest.ruleKey} this session`,
          },
        ]);
      }
      return;
    }

    // slash-command palette navigation
    if (suggestions.length > 0 && !busy) {
      if (key.upArrow) {
        setSelectedSuggestion((s) => (s - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (key.downArrow) {
        setSelectedSuggestion((s) => (s + 1) % suggestions.length);
        return;
      }
      if (key.tab) {
        setValue(`/${suggestions[selectedSuggestion]?.name ?? suggestions[0]?.name ?? ""}`);
        return;
      }
    }
  });

  const switchToSession = async (state: BrowserState): Promise<void> => {
    const target = state.sessions[state.selected];
    if (!target) return;
    try {
      const loaded = await service.switchTo(target.meta.id);
      setBrowser(undefined);
      setEntries([
        {
          kind: "notice",
          text: `switched to session ${loaded.meta.id} (${loaded.messages.length} messages)`,
        },
        ...loaded.messages
          .filter(
            (m): m is Extract<ChatMessage, { role: "user" | "assistant" }> =>
              m.role === "user" || m.role === "assistant",
          )
          .map((m): Entry => ({
            kind: "message",
            role: m.role,
            content: m.content,
          })),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteSession = async (state: BrowserState): Promise<void> => {
    const target = state.sessions[state.selected];
    if (!target) return;
    await store.delete(target.meta.id);
    const wasCurrent = target.meta.id === service.id;
    const remaining = (await store.list()).filter((s) => s.meta.id !== target.meta.id);
    if (wasCurrent) {
      await service.newSession();
      setEntries([
        {
          kind: "notice",
          text: `deleted ${target.meta.id} (was current) — started ${service.id}`,
        },
      ]);
    } else {
      setEntries((prev) => [
        ...prev,
        { kind: "notice", text: `deleted session ${target.meta.id}` },
      ]);
    }
    setBrowser({ sessions: remaining, selected: 0 });
  };

  const executeCommand = (command: string): boolean => {
    switch (command) {
      case "/exit":
        abortRef.current?.abort();
        exit();
        return true;
      case "/help":
        setEntries((prev) => [
          ...prev,
          {
            kind: "notice",
            text: "commands: /help, /new, /session, /exit · permissions: y once, n no, a always this session · flags: --yolo, --provider, --continue",
          },
        ]);
        return true;
      case "/new":
        if (busy || pending.length > 0) return false;
        void (async () => {
          await service.newSession();
          setEntries([
            { kind: "notice", text: `started new session ${service.id}` },
          ]);
        })();
        return true;
      case "/session":
        if (busy || pending.length > 0) return false;
        void (async () => {
          setBrowser({ sessions: await store.list(), selected: 0 });
        })();
        return true;
      default:
        return false;
    }
  };

  const submit = (): void => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // exact command wins immediately (even mid-busy for /exit)
    if (executeCommand(trimmed)) {
      setValue("");
      return;
    }

    // still typing a bare "/xyz": complete highlighted suggestion or reject
    if (/^\/[a-zA-Z]*$/.test(trimmed)) {
      const pick =
        suggestions.length > 0 ? suggestions[Math.min(selectedSuggestion, suggestions.length - 1)] : undefined;
      if (pick !== undefined) {
        setValue(`/${pick.name}`);
      } else {
        setEntries((prev) => [
          ...prev,
          { kind: "notice", text: `unknown command "${trimmed}" — try /help` },
        ]);
        setValue("");
      }
      return;
    }

    if (busy || pending.length > 0) return;
    setValue("");

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        for await (const event of service.send(trimmed, controller.signal)) {
          apply(event, setEntries, setLiveText, setError);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLiveText("");
        setBusy(false);
      }
    })();
  };

  const currentRequest = pending[0];

  return (
    <Box flexDirection="column" paddingX={1} paddingBottom={1}>
      <Static items={entries}>
        {(entry, i) => (
          <Box key={i} marginTop={i === 0 ? 1 : 0}>
            {entry.kind === "message" ? (
              entry.role === "user" ? (
                <Text>
                  <Text bold color="green">
                    you{" "}
                  </Text>
                  {entry.content}
                </Text>
              ) : (
                <Box flexDirection="column">
                  <Text bold color="cyan">
                    agent
                  </Text>
                  <MarkdownLite text={entry.content} />
                </Box>
              )
            ) : entry.kind === "notice" ? (
              <Text dimColor>ℹ {entry.text}</Text>
            ) : (
              <ToolLine entry={entry} />
            )}
          </Box>
        )}
      </Static>

      <Box marginTop={1}>
        {busy ? (
          liveText ? (
            <Text>
              <Text bold color="cyan">
                agent{" "}
              </Text>
              {liveText}
            </Text>
          ) : (
            <DotsSpinner label="thinking…" />
          )
        ) : null}
      </Box>

      {error ? (
        <Box marginBottom={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      ) : null}

      {browser !== undefined ? (
        <SessionBrowser
          sessions={browser.sessions}
          currentId={service.id}
          selected={browser.selected}
        />
      ) : null}

      {currentRequest ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text>
            <Text bold color="yellow">
              permission{" "}
            </Text>
            allow <Text bold>{currentRequest.summary}</Text>?{" "}
            <Text dimColor>
              [y] yes / [n] no
              {currentRequest.ruleKey !== undefined
                ? ` / [a] always (${currentRequest.toolName} · ${currentRequest.ruleKey})`
                : ""}
            </Text>
          </Text>
        </Box>
      ) : null}

      {!busy && !currentRequest && browser === undefined && (
        <>
          {suggestions.length > 0 && (
            <Box flexDirection="column">
              {suggestions.map((command, i) => (
                <Text key={command.name}>
                  <Text inverse={i === selectedSuggestion} color={i === selectedSuggestion ? "blue" : undefined}>
                    {`/${command.name}`.padEnd(11)}
                  </Text>
                  <Text dimColor> {command.description}</Text>
                </Text>
              ))}
              <Text dimColor> ↑/↓ select · tab complete · enter run</Text>
            </Box>
          )}
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            <TextInput
              value={value}
              onChange={setValue}
              onSubmit={submit}
              placeholder='Type a message… ("/" for commands)'
            />
          </Box>
        </>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          session {service.id} · {service.meta.provider}/{service.meta.model} · cwd{" "}
          {service.cwd}
          {allowedRules.length > 0 ? ` · always-allow: ${allowedRules.join(", ")}` : ""}
        </Text>
      </Box>
    </Box>
  );
}

function apply(
  event: ChatEvent,
  setEntries: React.Dispatch<React.SetStateAction<Entry[]>>,
  setLiveText: React.Dispatch<React.SetStateAction<string>>,
  setError: React.Dispatch<React.SetStateAction<string | undefined>>,
): void {
  switch (event.type) {
    case "user-message":
      setEntries((prev) => [
        ...prev,
        { kind: "message", role: "user", content: event.message.content },
      ]);
      break;
    case "text-delta":
      setLiveText((prev) => prev + event.delta);
      break;
    case "assistant-message": {
      setLiveText("");
      const hasTools = event.message.toolCalls && event.message.toolCalls.length > 0;
      if (!hasTools || event.message.content.trim() !== "") {
        setEntries((prev) => [
          ...prev,
          { kind: "message", role: "assistant", content: event.message.content },
        ]);
      }
      break;
    }
    case "tool-start": {
      let detail = "";
      try {
        const parsed = JSON.parse(event.argsJson || "{}") as Record<string, unknown>;
        const primary =
          parsed["path"] ?? parsed["command"] ?? parsed["pattern"] ?? undefined;
        detail =
          typeof primary === "string"
            ? primary.length > 60
              ? primary.slice(0, 57) + "…"
              : primary
            : event.toolName === "edit_file" && typeof parsed["oldText"] === "string"
              ? `${String(parsed["path"] ?? "")}: "${parsed["oldText"].slice(0, 30)}…"`
              : JSON.stringify(parsed).slice(0, 60);
      } catch {
        detail = event.argsJson;
      }
      setEntries((prev) => [
        ...prev,
        {
          kind: "tool",
          callId: event.callId,
          toolName: event.toolName,
          status: "running",
          detail,
        },
      ]);
      break;
    }
    case "tool-denied":
      setEntries((prev) => updateTool(prev, event.callId, "denied", `denied (${event.reason})`));
      break;
    case "tool-result":
      setEntries((prev) => updateTool(prev, event.callId, "done", summarize(event.output)));
      break;
    case "error":
      setError(event.error instanceof Error ? event.error.message : String(event.error));
      break;
  }
}

function updateTool(
  entries: Entry[],
  callId: string,
  status: "done" | "denied",
  extraDetail: string,
): Entry[] {
  const index = entries.findLastIndex((e) => e.kind === "tool" && e.callId === callId);
  if (index === -1) return entries;
  const updated = [...entries];
  const entry = updated[index];
  if (entry?.kind !== "tool") return entries;
  updated[index] = {
    ...entry,
    status,
    detail: `${entry.detail} · ${extraDetail}`,
  };
  return updated;
}

function summarize(output: string): string {
  const firstLine = output.split("\n")[0] ?? "";
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine;
}
