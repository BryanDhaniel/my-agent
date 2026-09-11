import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AgentHarness } from "../harness/harness.js";
import type { CredentialValidator, ProviderManager } from "../providers/manager.js";
import type { SetupPrompts } from "../providers/setup-flow.js";
import { ProviderSetupFlow } from "../providers/setup-flow.js";
import { getProvider, listModels } from "../providers/registry.js";
import { nextPermissionMode } from "../permissions/gate.js";
import type { PermissionMode, PermissionRequest, UiGate } from "../permissions/gate.js";
import type { LoadedSession, SessionStore } from "../session/store.js";
import type { ChatMessage } from "../agent/types.js";
import { MarkdownLite } from "./markdown.js";
import { SessionBrowser } from "./session-browser.js";
import { SLASH_COMMANDS, suggestCommands } from "./commands.js";
import {
  Diff,
  type Effort,
  ErrorLine,
  isEffort,
  nextEffort,
  NoticeLine,
  Panel,
  Paper,
  PaperText,
  PermissionBlock,
  Picker,
  PromptComposer,
  SecretPrompt,
  type PickerItem,
  RoleBlock,
  SessionHeader,
  StatusBar,
  SuggestionList,
  ThinkingLine,
  TodoList,
  ToolStatusLine,
  WarnLine,
} from "./ink.js";
import {
  appendDiff,
  appendNotice,
  appendPanel,
  appendTodo,
  appendWarning,
  initialViewState,
  reduceChatEvent,
  replaceEntries,
  setError,
  setBusy,
  type ChatViewState,
  type PanelRow,
  type ViewEntry,
} from "./view.js";
import { INK, SPACE } from "./theme.js";

interface BrowserState {
  sessions: LoadedSession[];
  selected: number;
}

/**
 * Provider/model setup is a small state machine. The sequence itself lives in
 * ProviderSetupFlow — this only supplies the prompts and renders the steps.
 */
type FlowState =
  | {
      kind: "pick";
      title: string;
      items: PickerItem[];
      selected: number;
      onPick: (id: string) => void;
    }
  | { kind: "api-key"; providerId: string; label: string; value: string; error?: string }
  | { kind: "confirm-remove"; providerId: string };

/**
 * Window in which an identical resubmit is treated as a duplicate key event
 * rather than a second request. Short enough that deliberately sending the
 * same text twice still works, long enough to absorb CRLF/echo duplication.
 */
const SUBMIT_DEDUPE_MS = 400;

/**
 * Sentinel for the welcome banner.
 *
 * It is the FIRST item of the transcript's <Static> list and is never removed,
 * so Ink writes it exactly once. Keeping the header in the dynamic region
 * instead meant Ink had to erase it the moment the first entry was committed;
 * because <Static> grows in the same frame, the erase target shifted and the
 * header came out chopped or doubled. <Static> is append-only (it renders
 * `items.slice(index)`), so the banner must own a permanent first slot.
 */
const HEADER_ITEM = Symbol("session-header");
type StaticItem = ViewEntry | typeof HEADER_ITEM;

export function App({
  service,
  gate,
  store,
  providers,
  validateCredential,
  initialMode = "manual",
  onModeChange,
}: {
  service: AgentHarness;
  gate: UiGate;
  store: SessionStore;
  providers: ProviderManager;
  /** Optional real validation during setup; absent means local checks only. */
  validateCredential?: CredentialValidator;
  /** Starting permission mode (mirrors the gate; `--yolo` starts "auto"). */
  initialMode?: PermissionMode;
  /** Called when shift+tab cycles the mode, so the runtime gate follows. */
  onModeChange?: (mode: PermissionMode) => void;
}): React.ReactElement {
  const { exit } = useApp();
  const [view, setView] = useState<ChatViewState>(initialViewState);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<PermissionRequest[]>([]);
  const [allowedRules, setAllowedRules] = useState<readonly string[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [browser, setBrowser] = useState<BrowserState | undefined>();
  const [verboseTool, setVerboseTool] = useState(false);
  /** Permission mode shown in the composer; shift+tab cycles it. */
  const [permMode, setPermMode] = useState<PermissionMode>(initialMode);
  /** Reasoning effort shown in the composer; /effort sets it. */
  const [effort, setEffort] = useState<Effort>("high");
  const abortRef = useRef<AbortController | undefined>(undefined);
  /** Synchronous "a turn is running" flag — see the guard in submit(). */
  const inFlightRef = useRef(false);
  /** Last accepted submit, for the duplicate-key guard in submit(). */
  const lastSubmitRef = useRef<{ text: string; at: number } | undefined>(undefined);

  const suggestions = suggestCommands(value, service.skillCommands);
  const busy = view.busy;
  const currentRequest = pending[0];

  const [flow, setFlow] = useState<FlowState | undefined>(undefined);
  /** Resolver for whichever prompt the setup flow is waiting on. */
  const pendingPrompt = useRef<((value: string | undefined) => void) | undefined>(
    undefined,
  );

  const setupFlow = useMemo(
    () =>
      new ProviderSetupFlow({
        providers,
        ...(validateCredential !== undefined ? { validate: validateCredential } : {}),
      }),
    [providers, validateCredential],
  );

  const closeFlow = (): void => {
    pendingPrompt.current = undefined;
    setFlow(undefined);
  };

  /** Hand a value back to the setup flow, or cancel it with undefined. */
  const resolvePrompt = (value: string | undefined): void => {
    const resolve = pendingPrompt.current;
    pendingPrompt.current = undefined;
    setFlow(undefined);
    resolve?.(value);
  };

  const activate = async (): Promise<void> => {
    try {
      service.setProvider(await providers.createProvider());
    } catch (err) {
      setView((s) => appendNotice(s, `✗ ${errText(err)}`));
    }
  };

  const runSetup = (providerId: string, forceCredential = false): void => {
    void (async () => {
      const outcome = await setupFlow.run(
        providerId,
        prompts,
        forceCredential ? { forceCredential: true } : {},
      );
      setFlow(undefined);

      if (outcome.status === "active") {
        const def = getProvider(outcome.providerId);
        await activate();
        setView((s) =>
          appendNotice(s, `✓ Active: ${def?.name ?? outcome.providerId} / ${outcome.modelId}`),
        );
      } else if (outcome.status === "cancelled") {
        setView((s) =>
          appendNotice(
            s,
            outcome.stage === "credential"
              ? "Provider setup cancelled."
              : "Model selection cancelled — the provider stays configured.",
          ),
        );
      } else {
        setView((s) => appendNotice(s, `✗ ${outcome.error.message}`));
      }
    })();
  };

  const openProviders = (): void => {
    void (async () => {
      const statuses = await providers.listProviders();
      setFlow({
        kind: "pick",
        title: "Select Provider",
        items: statuses.map((s) => ({
          id: s.id,
          label: s.name,
          detail: s.configured
            ? s.active
              ? "configured · active"
              : "configured"
            : "not configured",
        })),
        selected: Math.max(0, statuses.findIndex((s) => s.active)),
        onPick: (id) => runSetup(id),
      });
    })();
  };

  const openModels = (modelId?: string): void => {
    if (modelId !== undefined) {
      void applyModel(modelId);
      return;
    }
    const active = providers.getActive();
    const models = listModels(active.providerId);
    setFlow({
      kind: "pick",
      title: `Select model — ${getProvider(active.providerId)?.name ?? active.providerId}`,
      items: models.map((m) => ({
        id: m.id,
        label: m.name,
        detail: m.id === active.modelId ? "active" : m.id,
      })),
      selected: Math.max(0, models.findIndex((m) => m.id === active.modelId)),
      onPick: (id) => {
        // During setup the flow is waiting; otherwise this is a direct switch.
        if (pendingPrompt.current !== undefined) {
          resolvePrompt(id);
          return;
        }
        closeFlow();
        void applyModel(id);
      },
    });
  };

  const openProviderMenu = (providerId: string): void => {
    const def = getProvider(providerId);
    setFlow({
      kind: "pick",
      title: def?.name ?? providerId,
      items: [
        { id: "use", label: "Use current configuration" },
        { id: "key", label: "Change API key" },
        { id: "model", label: "Select model" },
        { id: "remove", label: "Remove configuration" },
        { id: "cancel", label: "Cancel" },
      ],
      selected: 0,
      onPick: (id) => {
        if (id === "use") {
          void (async () => {
            try {
              await providers.setProvider(providerId);
              await activate();
              setFlow(undefined);
              setView((s) => appendNotice(s, "✓ using current configuration"));
            } catch (err) {
              setFlow(undefined);
              setView((s) => appendNotice(s, `✗ ${errText(err)}`));
            }
          })();
          return;
        }
        if (id === "key") {
          runSetup(providerId, true);
          return;
        }
        if (id === "model") {
          openModels();
          return;
        }
        if (id === "remove") {
          setFlow({ kind: "confirm-remove", providerId });
          return;
        }
        closeFlow();
      },
    });
  };

  const applyModel = async (modelId: string): Promise<void> => {
    try {
      await providers.setModel(modelId);
      await activate();
      setView((s) => appendNotice(s, `✓ Model: ${modelId}`));
    } catch (err) {
      setView((s) => appendNotice(s, `✗ ${errText(err)}`));
    }
  };

  const removeProvider = async (providerId: string): Promise<void> => {
    try {
      await providers.remove(providerId);
      setView((s) => appendNotice(s, "credential removed"));
      await activate();
    } catch (err) {
      setView((s) => appendNotice(s, `✗ ${errText(err)}`));
    }
  };

  /** Prompts the setup flow uses. Each waits for a real user action. */
  const prompts: SetupPrompts = {
    askCredential: (provider) => {
      setFlow({
        kind: "api-key",
        providerId: provider.id,
        label: provider.credential.label,
        value: "",
      });
      return new Promise<string | undefined>((resolve) => {
        pendingPrompt.current = resolve;
      });
    },
    selectModel: (provider, models) => {
      const active = providers.getActive();
      setFlow({
        kind: "pick",
        title: `Select model — ${provider.name}`,
        items: models.map((m) => ({ id: m.id, label: m.name, detail: m.id })),
        selected: Math.max(0, models.findIndex((m) => m.id === active.modelId)),
        onPick: (id) => resolvePrompt(id),
      });
      return new Promise<string | undefined>((resolve) => {
        pendingPrompt.current = resolve;
      });
    },
  };

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

  // Keep the provider's reasoning effort in sync with the composer chip. The
  // provider ignores it when the active model does not support reasoning, so
  // this never sends an unsupported parameter.
  useEffect(() => {
    service.setReasoningEffort(effort);
  }, [service, effort]);


  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      abortRef.current?.abort();
      exit();
      return;
    }

    // shift+tab cycles the permission mode (auto -> manual -> plan). Plain tab
    // stays reserved for slash-command autocomplete below.
    if (key.tab && key.shift) {
      const next = nextPermissionMode(permMode);
      setPermMode(next);
      onModeChange?.(next);
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

    // Provider/model setup takes over the keyboard while it is open.
    if (flow !== undefined) {
      if (key.escape) {
        resolvePrompt(undefined);
        return;
      }

      if (flow.kind === "api-key") {
        if (key.return) {
          if (flow.value.trim() === "") {
            setFlow({ ...flow, error: "the API key cannot be empty" });
            return;
          }
          const value = flow.value;
          setFlow(undefined);
          resolvePrompt(value);
          return;
        }
        if (key.backspace || key.delete) {
          setFlow({ ...flow, value: flow.value.slice(0, -1), error: undefined });
          return;
        }
        // Printable input only: arrows and control keys arrive with input "".
        if (input !== "" && !key.return && !key.tab) {
          setFlow({ ...flow, value: flow.value + input, error: undefined });
        }
        return;
      }

      if (flow.kind === "confirm-remove") {
        if (input === "y") {
          const id = flow.providerId;
          setFlow(undefined);
          void removeProvider(id);
        } else if (input === "n" || input === "N" || key.return) {
          closeFlow();
        }
        return;
      }

      const items = flow.items;
      if (items.length === 0) return;
      if (key.upArrow) {
        setFlow({ ...flow, selected: (flow.selected - 1 + items.length) % items.length });
      } else if (key.downArrow) {
        setFlow({ ...flow, selected: (flow.selected + 1) % items.length });
      } else if (key.return) {
        const picked = items[flow.selected];
        if (picked !== undefined) flow.onPick(picked.id);
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

    // esc interrupts a running turn. ThinkingLine advertises this, and the
    // composer is unmounted while busy, so nothing else claims the key here.
    if (busy && key.escape) {
      abortRef.current?.abort();
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

  const handleProviderCommand = (args: string[]): void => {
    if (args.length === 0) {
      openProviders();
      return;
    }

    if (args[0] === "remove") {
      const id = args[1];
      if (id === undefined) {
        setView((s) => appendNotice(s, "usage: /provider remove <provider>"));
        return;
      }
      setFlow({ kind: "confirm-remove", providerId: id });
      return;
    }

    const id = args[0] ?? "";
    if (getProvider(id) === undefined) {
      setView((s) => appendNotice(s, `unknown provider "${id}", try /provider`));
      return;
    }

    void (async () => {
      if (await providers.isConfigured(id)) {
        openProviderMenu(id);
      } else {
        runSetup(id);
      }
    })();
  };

  const executeCommand = (command: string): boolean => {
    // Handled here, never forwarded to the model.
    const [head, ...rest] = command.split(/\s+/);
    if (head === "/provider") {
      handleProviderCommand(rest);
      return true;
    }
    if (head === "/model") {
      openModels(rest[0]);
      return true;
    }
    if (head === "/effort") {
      // `/effort <level>` sets it; bare `/effort` cycles to the next level.
      const requested = rest[0]?.toLowerCase();
      const next = requested !== undefined && isEffort(requested) ? requested : nextEffort(effort);
      setEffort(next);
      setView((s) => appendNotice(s, `reasoning effort: ${next}`));
      return true;
    }

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
      case "/todo": {
        // Demo: render the task-list grammar that the agent will use when it
        // plans multi-step work. Real agents will emit this via AgentEvent.
        setView((s) =>
          appendTodo(s, [
            { label: "Read the settings page", status: "done" },
            { label: "Add the dark-mode toggle", status: "active" },
            { label: "Run the test suite", status: "todo" },
          ]),
        );
        return true;
      }
      case "/diff": {
        // Demo: render the inline-diff grammar that the agent will use when it
        // edits a file. Real agents will emit this via AgentEvent.
        setView((s) =>
          appendDiff(
            s,
            "app/settings/page.tsx",
            [
              { type: "ctx", n: 11, text: "export function Settings() {" },
              { type: "del", n: 12, text: "  return <Panel>{sections}</Panel>" },
              { type: "add", n: 12, text: "  return (" },
              { type: "add", n: 13, text: "    <Panel header={<ThemeToggle />}>" },
              { type: "add", n: 14, text: "      {sections}" },
              { type: "ctx", n: 15, text: "    </Panel>" },
            ],
            "Updated app/settings/page.tsx with 3 additions and 1 removal",
          ),
        );
        return true;
      }
      case "/mcp": {
        // Demo: render the amber MCP authentication warning.
        setView((s) =>
          appendWarning(s, "3 MCP servers need authentication · run /mcp"),
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

    // `busy` is React state, so it is still false for any Enter that arrives
    // before the next render commits — that is how one prompt became two or
    // three concurrent turns (and hence two or three `❯` copies). A ref is
    // updated synchronously, so it can never be stale.
    if (busy || currentRequest || inFlightRef.current) return;

    // Windows terminals deliver Enter as CRLF, so a single physical Enter can
    // raise several return events; some terminals also echo input back when
    // raw mode is only partly applied. Either way the same text can reach here
    // repeatedly. Ignore an immediate repeat of the same prompt.
    const now = Date.now();
    const last = lastSubmitRef.current;
    if (last !== undefined && last.text === outgoing && now - last.at < SUBMIT_DEDUPE_MS) {
      return;
    }
    lastSubmitRef.current = { text: outgoing, at: now };

    inFlightRef.current = true;
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
        // An interrupt is a normal outcome, not a failure: showing
        // "AbortError" would look like the request broke.
        if (!controller.signal.aborted) {
          setView((s) => setError(s, err instanceof Error ? err.message : String(err)));
        }
      } finally {
        inFlightRef.current = false;
        setView((s) => {
          const settled = { ...setBusy(s, false), liveText: "" };
          return controller.signal.aborted
            ? appendNotice(settled, "interrupted — esc stopped this turn")
            : settled;
        });
      }
    })();
  };

  const APP_VERSION = "0.1.0";

  /**
   * Map a PermissionBlock radiogroup selection to a gate response.
   * Options are [Yes, (Yes+always)?, No]; with no ruleKey the middle option
   * collapses into "No", so index 1 means deny in that shape.
   */
  const choosePermission = (index: number): void => {
    if (!currentRequest) return;
    const withAlways = currentRequest.ruleKey !== undefined;
    if (index === 0) {
      gate.respond(currentRequest.id, "once");
    } else if (index === 1 && withAlways) {
      gate.respond(currentRequest.id, "always");
      setView((s) =>
        appendNotice(
          s,
          `always allowing ${currentRequest.toolName} ${currentRequest.ruleKey} this session`,
        ),
      );
    } else {
      gate.respond(currentRequest.id, "deny");
    }
  };

  // The transcript is written ONCE through <Static> instead of being redrawn
  // with the rest of the frame. Without this, every keystroke and every
  // streamed token repainted the whole conversation, so terminal scrollback
  // accumulated a copy per frame and looked like duplicated messages.
  // The newest entry stays dynamic: it is the only one that mutates in place
  // (a tool going running -> done). Remounted wholesale on /new, switch or
  // delete via transcriptGen, so replaced content is rewritten, not appended.
  // Only a tool that is still running needs to stay dynamic, because it is the
  // one entry that mutates in place (running -> done). Everything else is final
  // the moment it is created, so it goes to Static immediately — keeping it
  // dynamic would redraw it every frame and then write it AGAIN when it later
  // moved into Static, which is exactly what made each message appear twice.
  const lastEntry = view.entries[view.entries.length - 1];
  const liveTool =
    lastEntry !== undefined && lastEntry.kind === "tool" && lastEntry.status === "running"
      ? lastEntry
      : undefined;
  const settledEntries = liveTool !== undefined ? view.entries.slice(0, -1) : view.entries;
  const trailingEntry = liveTool;

  /**
   * True once the current turn has produced its answer.
   *
   * Must look past trailing notices: after the reply the harness still appends
   * "memory · saved …", so the newest entry is a notice, not the answer —
   * checking only the last entry left the spinner showing after every turn.
   */
  const lastUserIndex = view.entries.reduce(
    (acc, entry, i) =>
      entry.kind === "message" && entry.role === "user" ? i : acc,
    -1,
  );
  const answered =
    lastUserIndex >= 0 &&
    view.entries
      .slice(lastUserIndex + 1)
      .some((entry) => entry.kind === "message" && entry.role === "assistant");

  // The welcome banner is the first, permanent static item (see HEADER_ITEM);
  // the settled transcript follows it. <Static> is append-only, so the header
  // slot must never be dropped once Ink has written it.
  const staticItems: StaticItem[] = [HEADER_ITEM, ...settledEntries];

  return (
    <Paper>
      <Static key={view.transcriptGen} items={staticItems}>
        {(item, i) =>
          item === HEADER_ITEM ? (
            <SessionHeader
              key="header"
              brand="my-agent"
              version={APP_VERSION}
              model={`${service.meta.provider}/${service.meta.model}`}
              cwd={service.cwd}
              tips={[
                "Ask for a change, or / for commands",
                "/provider to pick a model",
                "/skills to list what's loaded",
              ]}
              whatsNew={[
                "Added /todo and /diff to demo screen grammar",
                "Added effort chip and token counter to the prompt",
              ]}
            />
          ) : (
            <Box key={i} flexDirection="column" marginTop={SPACE.turnGap}>
              <EntryLine entry={item} verbose={verboseTool} />
            </Box>
          )
        }
      </Static>

      {trailingEntry !== undefined ? (
        <Box flexDirection="column" marginTop={SPACE.turnGap}>
          <EntryLine entry={trailingEntry} verbose={verboseTool} />
        </Box>
      ) : null}

        {/*
          Deliberately no live streaming preview. The streamed text is drawn in
          the dynamic region, and the committed reply is then written again by
          <Static> — so a turn printed its answer twice whenever the dynamic
          region grew enough to scroll. Showing the thinking line until the
          reply is committed keeps each answer written exactly once.
        */}
        {/*
          Only while waiting for the answer. Once an assistant message is on
          screen the turn is just finishing up (memory, compaction) — showing
          "Thinking…" again printed a second, redundant spinner for every turn.
        */}
        {busy && !answered ? (
          <Box marginTop={1}>
            <ThinkingLine />
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

        {flow !== undefined ? <FlowView flow={flow} /> : null}

        {currentRequest ? (
          <PermissionBlock request={currentRequest} onChoose={choosePermission} />
        ) : null}

        {!busy && !currentRequest && browser === undefined && flow === undefined && (
          <>
            {suggestions.length > 0 && (
              <SuggestionList commands={suggestions} selected={selectedSuggestion} />
            )}
          <PromptComposer
            value={value}
            onChange={handleChange}
            onSubmit={submit}
            placeholder="Ask a question, or / for commands"
            mode={permMode}
            effort={effort}
          />
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

/**
 * Provider/model setup UI. Presentation only — the sequence and the rules
 * live in ProviderSetupFlow and ProviderManager.
 */
function FlowView({ flow }: { flow: FlowState }): React.ReactElement {
  if (flow.kind === "api-key") {
    return (
      <SecretPrompt
        label={flow.label}
        length={flow.value.length}
        {...(flow.error !== undefined ? { error: flow.error } : {})}
      />
    );
  }

  if (flow.kind === "confirm-remove") {
    const name = getProvider(flow.providerId)?.name ?? flow.providerId;
    return (
      <Box flexDirection="column" marginLeft={SPACE.contentIndent} marginBottom={1}>
        <Text {...INK.strong}>{`Remove ${name} configuration?`}</Text>
        <Text {...INK.dim}>y remove · n cancel</Text>
      </Box>
    );
  }

  return <Picker title={flow.title} items={flow.items} selected={flow.selected} />;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
          <PaperText text={entry.content} bold />
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
    case "todo":
      return <TodoList todos={entry.todos} />;
    case "diff":
      return (
        <Diff
          file={entry.file}
          lines={entry.lines}
          {...(entry.summary !== undefined ? { summary: entry.summary } : {})}
        />
      );
    case "warning":
      return <WarnLine>{entry.text}</WarnLine>;
  }
}
