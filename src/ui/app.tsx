import { Box, Text, useApp, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import TextInput from "ink-text-input";
import type { AgentHarness } from "../harness/harness.js";
import type { PermissionRequest, UiGate } from "../permissions/gate.js";
import type { LoadedSession, SessionStore } from "../session/store.js";
import type { ChatMessage } from "../agent/types.js";
import { MarkdownLite } from "./markdown.js";
import { SessionBrowser } from "./session-browser.js";
import { SLASH_COMMANDS, suggestCommands } from "./commands.js";
import {
  ErrorLine,
  Header,
  NoticeLine,
  Panel,
  Paper,
  PaperText,
  PermissionBlock,
  RoleBlock,
  Spinner,
  StatusBar,
  SuggestionList,
  ToolStatusLine,
  Welcome,
} from "./ink.js";
import {
  appendNotice,
  appendPanel,
  initialViewState,
  reduceChatEvent,
  replaceEntries,
  setError,
  setBusy,
  type ChatViewState,
  type PanelRow,
  type ViewEntry,
} from "./view.js";
import { MARK, SPACE } from "./theme.js";

interface BrowserState {
  sessions: LoadedSession[];
  selected: number;
}

export function App({
  service,
  gate,
  store,
}: {
  service: AgentHarness;
  gate: UiGate;
  store: SessionStore;
}): React.ReactElement {
  const { exit } = useApp();
  const [view, setView] = useState<ChatViewState>(initialViewState);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<PermissionRequest[]>([]);
  const [allowedRules, setAllowedRules] = useState<readonly string[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [browser, setBrowser] = useState<BrowserState | undefined>();
  const [verboseTool, setVerboseTool] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const suggestions = suggestCommands(value, service.skillCommands);
  const busy = view.busy;
  const currentRequest = pending[0];

  // Reset the highlight synchronously with the edit. Doing this in an effect
  // let a late effect run clobber an arrow keypress made just after typing.
  const handleChange = (next: string): void => {
    setValue(next);
    setSelectedSuggestion(0);
  };

  useEffect(() => {
    gate.onPendingChange((p) => {
      setPending(p);
      setAllowedRules(gate.allowedRules);
    });
    return () => gate.onPendingChange(() => {});
  }, [gate]);


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

    if (currentRequest) {
      if (input === "y") gate.respond(currentRequest.id, "once");
      if (input === "n") gate.respond(currentRequest.id, "deny");
      if (input === "a" && currentRequest.ruleKey !== undefined) {
        gate.respond(currentRequest.id, "always");
        setView((s) =>
          appendNotice(
            s,
            `always allowing ${currentRequest.toolName} ${currentRequest.ruleKey} this session`,
          ),
        );
      }
      return;
    }

    // verbose Tool Results: `v` while the prompt is hidden mid-Turn,
    // or /verbose any time — typing "v" into the input is never hijacked.
    if (busy && input === "v") {
      setVerboseTool((v) => !v);
      return;
    }

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
      const replayed: ViewEntry[] = loaded.messages.filter(
        (m): m is Extract<ChatMessage, { role: "user" | "assistant" }> =>
          m.role === "user" || m.role === "assistant",
      ).map((m) => ({ kind: "message", role: m.role, content: m.content }));
      // Notice last: replaceEntries would otherwise wipe the confirmation.
      setView((s) =>
        appendNotice(
          replaceEntries(s, replayed),
          `switched to session ${loaded.meta.id}, ${loaded.messages.length} messages`,
        ),
      );
    } catch (err) {
      setView(setError(initialViewState(), err instanceof Error ? err.message : String(err)));
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
      setView((s) =>
        appendNotice(
          replaceEntries(s, []),
          `deleted ${target.meta.id}, started ${service.id}`,
        ),
      );
    } else {
      setView((s) => appendNotice(s, `deleted session ${target.meta.id}`));
    }
    setBrowser({ sessions: remaining, selected: 0 });
  };

  /** Rows for /skills: one per registered skill, alphabetically. */
  const skillRows = (): PanelRow[] =>
    [...service.skills.list()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({
        label: `/${s.name}`,
        tag: s.invocation,
        detail: s.description === "" ? s.source : s.description,
      }));

  const showHelp = (): void => {
    const commandRows: PanelRow[] = SLASH_COMMANDS.map((c) => ({
      label: `/${c.name}`,
      detail: c.description,
    }));
    const keyRows: PanelRow[] = [
      { label: "y / n", detail: "allow once / deny a tool call" },
      { label: "a", detail: "always allow that tool this session" },
      { label: "v", detail: "toggle full tool output during a turn" },
      { label: "ctrl+c", detail: "abort and quit" },
    ];
    setView((s) => appendPanel(appendPanel(s, "Commands", commandRows), "Keys", keyRows));
  };

  const executeCommand = (command: string): boolean => {
    switch (command) {
      case "/exit":
        abortRef.current?.abort();
        exit();
        return true;
      case "/help":
        showHelp();
        return true;
      case "/new":
        if (busy || currentRequest) return false;
        void (async () => {
          await service.newSession();
          setView((s) =>
            appendNotice(replaceEntries(s, []), `started new session ${service.id}`),
          );
        })();
        return true;
      case "/session":
        if (busy || currentRequest) return false;
        void (async () => {
          setBrowser({ sessions: await store.list(), selected: 0 });
        })();
        return true;
      case "/verbose":
        setVerboseTool((v) => !v);
        setView((s) => appendNotice(s, `tool output ${verboseTool ? "hidden" : "shown"}`));
        return true;
      case "/skills": {
        const rows = skillRows();
        setView((s) =>
          appendPanel(
            s,
            `Skills (${rows.length})`,
            rows,
            "no skills found, add a directory containing SKILL.md under skills/ or .agents/skills/",
          ),
        );
        return true;
      }
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

    // A bare command token — "/" alone, "/ski", "/skills-x". Enter runs the
    // highlighted suggestion, so arrowing down to /skills and pressing enter
    // actually runs it instead of sending "/" to the model.
    let outgoing = trimmed;
    if (/^\/[a-zA-Z0-9-]*$/.test(trimmed)) {
      const pick =
        suggestions.length > 0
          ? suggestions[Math.min(selectedSuggestion, suggestions.length - 1)]
          : undefined;

      if (pick === undefined) {
        setView((s) => appendNotice(s, `unknown command "${trimmed}", try /help or /skills`));
        setValue("");
        return;
      }

      if (service.skills.has(pick.name)) {
        // Skill invocation — hand the skill's own command to the harness.
        outgoing = `/${pick.name}`;
      } else {
        if (executeCommand(`/${pick.name}`)) {
          setValue("");
          return;
        }
        setView((s) => appendNotice(s, `unknown command "${trimmed}", try /help`));
        setValue("");
        return;
      }
    }

    if (busy || currentRequest) return;
    setValue("");

    const controller = new AbortController();
    abortRef.current = controller;
    setView((s) => setBusy(s, true));

    void (async () => {
      try {
        for await (const event of service.run(outgoing, controller.signal)) {
          setView((prev) => reduceChatEvent(prev, event as any));
        }
      } catch (err) {
        setView((s) => setError(s, err instanceof Error ? err.message : String(err)));
      } finally {
        setView((s) => ({ ...setBusy(s, false), liveText: "" }));
      }
    })();
  };

  return (
    <Paper>
      <Header />

      {/*
        Deliberately NOT <Static>: entries can be replaced wholesale (/new,
        session switch, delete), and Static only draws items it has not yet
        rendered, so replaced content would silently never appear.
      */}
      <Box flexDirection="column">
        {view.entries.map((entry, i) => (
          <Box key={i} flexDirection="column" marginTop={SPACE.turnGap}>
            <EntryLine entry={entry} verbose={verboseTool} />
          </Box>
        ))}
      </Box>

      {view.entries.length === 0 && !busy && browser === undefined && <Welcome />}

      {busy ? (
        <Box marginTop={1}>
          {view.liveText ? (
            <RoleBlock role="agent">
              <MarkdownLite text={view.liveText} />
            </RoleBlock>
          ) : (
            <Spinner label="thinking" />
          )}
        </Box>
      ) : null}

      {view.error ? (
        <Box marginTop={1}>
          <ErrorLine>{view.error}</ErrorLine>
        </Box>
      ) : null}

      {browser !== undefined ? (
        <SessionBrowser
          sessions={browser.sessions}
          currentId={service.id}
          selected={browser.selected}
        />
      ) : null}

      {currentRequest ? <PermissionBlock request={currentRequest} /> : null}

      {!busy && !currentRequest && browser === undefined && (
        <>
          {suggestions.length > 0 && (
            <SuggestionList commands={suggestions} selected={selectedSuggestion} />
          )}
          <Box marginLeft={SPACE.contentIndent}>
            <Text {...{ bold: true, color: "cyan" }}>{MARK.prompt} </Text>
            <TextInput
              value={value}
              onChange={handleChange}
              onSubmit={submit}
              placeholder="Ask a question, or / for commands"
            />
          </Box>
        </>
      )}

      <StatusBar
        fields={[
          `session ${service.id}`,
          `${service.meta.provider}/${service.meta.model}`,
          `cwd ${service.cwd}`,
          `${service.skills.size} skills`,
          ...(allowedRules.length > 0 ? [`always: ${allowedRules.join(", ")}`] : []),
          ...(verboseTool ? ["tool output shown"] : []),
        ]}
      />
    </Paper>
  );
}

function EntryLine({
  entry,
  verbose,
}: {
  entry: ViewEntry;
  verbose: boolean;
}): React.ReactElement {
  switch (entry.kind) {
    case "message":
      return entry.role === "user" ? (
        <RoleBlock role="you">
          <PaperText text={entry.content} />
        </RoleBlock>
      ) : (
        <RoleBlock role="agent">
          <MarkdownLite text={entry.content} />
        </RoleBlock>
      );
    case "notice":
      return <NoticeLine text={entry.text} />;
    case "tool":
      return <ToolStatusLine entry={entry} verbose={verbose} />;
    case "panel":
      return <Panel view={entry} />;
  }
}
