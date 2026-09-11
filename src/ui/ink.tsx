import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import React, { useEffect, useState } from "react";
import type { PermissionMode, PermissionRequest } from "../permissions/gate.js";
import type { ReasoningEffort } from "../providers/provider.js";
import type { SlashCommand } from "./commands.js";
import type { PanelView, ToolView } from "./view.js";
import {
  INK,
  MARK,
  PAPER,
  PALETTE,
  RULE,
  SPACE,
  THINK_FRAMES,
  THINK_VERBS,
  frameBox,
  paperWidth,
  ruleLine,
  wrapPaper,
} from "./theme.js";

/** Spinner frames — braille dots, the terminal convention. */
const DROP_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/**
 * The presentation seam. Components express intent ("this is an error",
 * "this is a tool call"); every glyph, colour, margin, and weight decision
 * lives in theme.ts. Callers never touch tokens directly.
 *
 * The grammar below is a faithful port of the claude-session reference:
 *   ⏺ tool(arg)   — the call sits on the bullet, its identifier in cyan
 *     ⎿ result    — the result rides the rail below
 *   ❯ you         — user turns carry the prompt caret
 *   ✢ Verb…       — the drifting "thinking" line
 *   ╭─ title ─╮   — bordered frames for headers and permission prompts
 */

function useContentWidth(): number {
  const { stdout } = useStdout();
  return paperWidth(stdout?.columns) - SPACE.contentIndent;
}

/** The page itself: a gutter so text never touches the screen wall. */
export function Paper({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      paddingBottom={1}
      paddingLeft={PAPER.marginLeft}
      paddingRight={PAPER.marginLeft}
    >
      {children}
    </Box>
  );
}

/** Full-width rule across the usable width. */
export function Rule({
  weight,
}: {
  weight: keyof typeof RULE;
}): React.ReactElement {
  const { stdout } = useStdout();
  return <Text {...INK.rail}>{ruleLine(weight, stdout?.columns)}</Text>;
}

/** Brand line. One row, no ornamental rule. */
export function Header(): React.ReactElement {
  return (
    <Box marginBottom={1}>
      <Text {...INK.strong}>my-agent</Text>
    </Box>
  );
}

/** Plain text set to the paper edge (wrapped, never clipped). */
export function PaperText({
  text,
  bold = false,
}: {
  text: string;
  bold?: boolean;
}): React.ReactElement {
  const width = useContentWidth();
  return (
    <Box flexDirection="column">
      {wrapPaper(text, Math.max(20, width)).map((line, i) =>
        line === "" ? (
          <Text key={i}> </Text>
        ) : (
          <Text key={i} {...(bold ? INK.strong : {})}>
            {line}
          </Text>
        ),
      )}
    </Box>
  );
}

/**
 * A spoken turn, ported from claude-message.
 *
 * The user turn is a full-width `❯` row — the caret in the accent, the words
 * bold — exactly how Claude Code renders your prompt. The agent turn is plain
 * prose with no marker, matching the reference's assistant style; role clarity
 * comes from the caret itself, not a label.
 */
export function RoleBlock({
  role,
  children,
}: {
  role: "you" | "agent";
  children: React.ReactNode;
}): React.ReactElement {
  if (role === "you") {
    return (
      <Box flexDirection="row">
        <Text {...INK.strong}>{MARK.prompt} </Text>
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
      </Box>
    );
  }
  return <Box flexDirection="column">{children}</Box>;
}

export function ErrorLine({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box marginLeft={SPACE.contentIndent}>
      <Text {...INK.error}>
        {MARK.toolFailed} {children}
      </Text>
    </Box>
  );
}

/**
 * Lifecycle noise (memory saved, context compacted). Readable gray —
 * deliberately not dimColor, which disappears on many terminals.
 */
export function NoticeLine({ text }: { text: string }): React.ReactElement {
  return (
    <Box marginLeft={SPACE.contentIndent}>
      <Text {...INK.dim}>
        {MARK.notice} {text}
      </Text>
    </Box>
  );
}

/**
 * Amber-colored warning, like the MCP authentication prompt. Uses the same
 * readable weight as NoticeLine — the colour does the talking.
 */
export function WarnLine({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box>
      <Text {...INK.warn}>
        ⚠ {children}
      </Text>
    </Box>
  );
}

const VERBOSE_MAX_LINES = 40;

/**
 * One tool call, ported from claude-tool-call: the call rides `⏺` and its
 * result rides `⎿` on the rail directly below. The identifier is cyan, the
 * rails and parens are faint, and the status glyph carries the colour — green
 * for done, terracotta-red for denied, amber while running.
 */
export function ToolStatusLine({
  entry,
  verbose,
}: {
  entry: ToolView;
  verbose: boolean;
}): React.ReactElement {
  const { stdout } = useStdout();
  const width = paperWidth(stdout?.columns);

  const markInk =
    entry.status === "running"
      ? INK.warn
      : entry.status === "denied"
        ? INK.error
        : INK.ok;

  const [argPart, resultPart] = splitDetail(entry.detail);

  const call = (
    <Text>
      <Text {...markInk}>{MARK.toolCall} </Text>
      <Text {...INK.strong}>{entry.toolName}</Text>
      {argPart !== "" ? (
        <Text>
          <Text {...INK.rail}>(</Text>
          <Text {...INK.arg}>{argPart}</Text>
          <Text {...INK.rail}>)</Text>
        </Text>
      ) : null}
    </Text>
  );

  const resultText =
    entry.status === "running"
      ? "running…"
      : resultPart !== undefined
        ? resultPart
        : entry.detail;

  const result = (
    <Text>
      <Text {...INK.rail}>  {MARK.toolResult} </Text>
      <Text {...(entry.status === "denied" ? INK.error : INK.dim)}>{resultText}</Text>
    </Text>
  );

  const outputLines =
    verbose && entry.output !== undefined && entry.output !== ""
      ? wrapPaper(
          entry.output.split("\n").slice(-VERBOSE_MAX_LINES).join("\n"),
          width,
        )
      : [];

  return (
    <Box flexDirection="column" marginLeft={SPACE.contentIndent}>
      {call}
      {result}
      {outputLines.length > 0 && (
        <Box flexDirection="column" marginLeft={SPACE.contentIndent}>
          {outputLines.map((line, i) =>
            line === "" ? (
              <Text key={i}> </Text>
            ) : (
              <Text key={`o-${i}`} {...INK.dim}>
                {line}
              </Text>
            ),
          )}
        </Box>
      )}
    </Box>
  );
}

/** Split "arg · result" into its two halves; args with no result stay whole. */
function splitDetail(detail: string): [string, string | undefined] {
  const idx = detail.indexOf(" · ");
  if (idx === -1) return [detail, undefined];
  return [detail.slice(0, idx), detail.slice(idx + 3)];
}

/**
 * Permission Gate prompt, ported from claude-permission: a rose-bordered
 * frame with the request seated in its top edge, the command it would run,
 * and a numbered radiogroup. Arrow keys move the selection, Enter (or the
 * letter shortcuts) chooses — the agent itself never gets to approve.
 */
export function PermissionBlock({
  request,
  onChoose,
}: {
  request: PermissionRequest;
  onChoose: (index: number) => void;
}): React.ReactElement {
  const options =
    request.ruleKey !== undefined
      ? [
          "Yes",
          "Yes, and don't ask again this session",
          "No, and tell the agent what to do",
        ]
      : ["Yes", "No, and tell the agent what to do"];

  const [sel, setSel] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSel((s) => (s - 1 + options.length) % options.length);
    } else if (key.downArrow) {
      setSel((s) => (s + 1) % options.length);
    } else if (key.return || key.escape) {
      onChoose(key.escape ? options.length - 1 : sel);
    }
  });

  const frame = frameBox(
    request.toolName,
    [request.summary, "", "Do you want to proceed?"],
    paperWidth(useStdout().stdout?.columns),
  );

  return (
    <Box flexDirection="column" marginY={1}>
      {frame.map((line, i) => (
        <Text
          key={i}
          {...(i === 0 || i === frame.length - 1 ? INK.accent : INK.body)}
        >
          {line}
        </Text>
      ))}
      <Box flexDirection="column" marginLeft={SPACE.contentIndent} marginTop={1}>
        {options.map((opt, i) => {
          const active = i === sel;
          return (
            <Text key={i}>
              <Text {...(active ? INK.accent : INK.rail)}>
                {active ? `${MARK.selector} ` : "  "}
              </Text>
              <Text {...(active ? INK.strong : INK.dim)}>{`${i + 1}. ${opt}`}</Text>
            </Text>
          );
        })}
        <Text {...INK.faint}> ↑↓ move · enter choose · y yes · n no · a always</Text>
      </Box>
    </Box>
  );
}

/** Braille spinner — the terminal convention. Kept for non-thinking waits. */
export function Spinner({ label }: { label: string }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % DROP_FRAMES.length),
      80,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <Box marginLeft={SPACE.contentIndent}>
      <Text>
        <Text {...INK.accent}>{DROP_FRAMES[frame]}</Text> <Text {...INK.dim}>{label}</Text>
      </Text>
    </Box>
  );
}

/** Slash-command autocomplete. The selection is marked, not just coloured. */
export function SuggestionList({
  commands,
  selected,
}: {
  commands: SlashCommand[];
  selected: number;
}): React.ReactElement {
  const width = Math.max(
    ...commands.map((c) => `/${c.name}`.length),
  );
  return (
    <Box flexDirection="column" marginLeft={SPACE.contentIndent} marginBottom={1}>
      {commands.map((command, i) => {
        const isActive = i === selected;
        return (
          <Text key={command.name}>
            <Text {...(isActive ? INK.accent : INK.dim)}>
              {isActive ? `${MARK.prompt} ` : "  "}
              {`/${command.name}`.padEnd(width + 2)}
            </Text>
            <Text {...(isActive ? INK.strong : INK.dim)}>{command.description}</Text>
          </Text>
        );
      })}
      <Text {...INK.faint}> ↑↓ select · tab complete · enter run</Text>
    </Box>
  );
}

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
}

/** Interactive list used by /provider and /model. */
export function Picker({
  title,
  items,
  selected,
  hint = "↑↓ select · enter confirm · esc cancel",
}: {
  title: string;
  items: PickerItem[];
  selected: number;
  hint?: string;
}): React.ReactElement {
  const width = Math.max(0, ...items.map((item) => item.label.length));
  return (
    <Box flexDirection="column" marginLeft={SPACE.contentIndent} marginBottom={1}>
      <Text {...INK.strong}>{title}</Text>
      <Box height={1} />
      {items.map((item, i) => {
        const isActive = i === selected;
        return (
          <Text key={item.id}>
            <Text {...(isActive ? INK.accent : INK.dim)}>
              {isActive ? `${MARK.prompt} ` : "  "}
              {item.label.padEnd(width + 2)}
            </Text>
            {item.detail !== undefined ? (
              <Text {...(isActive ? INK.strong : INK.dim)}>{item.detail}</Text>
            ) : null}
          </Text>
        );
      })}
      <Text {...INK.faint}> {hint}</Text>
    </Box>
  );
}

/**
 * Masked credential entry.
 *
 * The value is rendered as dots only. It is never echoed, never written to
 * the transcript, and never included in a notice.
 */
export function SecretPrompt({
  label,
  length,
  error,
  hint,
}: {
  label: string;
  length: number;
  error?: string;
  hint?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginLeft={SPACE.contentIndent} marginBottom={1}>
      <Text {...INK.strong}>{label}</Text>
      <Box height={1} />
      <Text>
        <Text {...{ bold: true, color: PALETTE.arg }}>{MARK.prompt} </Text>
        <Text>{length > 0 ? "•".repeat(Math.min(length, 40)) : ""}</Text>
        {length > 40 ? <Text {...INK.dim}>{` (+${length - 40})`}</Text> : null}
      </Text>
      {error !== undefined ? <Text {...INK.error}>{error}</Text> : null}
      <Text {...INK.faint}> {hint ?? "enter submit · esc cancel"}</Text>
    </Box>
  );
}

/**
 * Answer to "show me the set of X" — /skills, /help, and friends.
 * Real rows with aligned columns, so command output is legible at a glance
 * instead of being buried in dim prose.
 */
export function Panel({ view }: { view: PanelView }): React.ReactElement {
  const width = useContentWidth();
  const labelWidth = Math.max(0, ...view.rows.map((r) => r.label.length));

  if (view.rows.length === 0) {
    return (
      <Box flexDirection="column" marginLeft={SPACE.contentIndent}>
        <Text {...INK.strong}>{view.title}</Text>
        <Text {...INK.dim}>{view.emptyText ?? "none"}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={SPACE.contentIndent}>
      <Text {...INK.strong}>{view.title}</Text>
      <Box height={1} />
      {view.rows.map((row, i) => (
        <Box key={`${row.label}-${i}`} flexDirection="row">
          <Text {...INK.accent}>{row.label.padEnd(labelWidth + 2)}</Text>
          {row.tag !== undefined ? (
            <Text {...INK.dim}>{`${row.tag} `.padEnd(7)}</Text>
          ) : null}
          <Box flexShrink={1}>
            <Text {...INK.body}>
              {wrapPaper(row.detail, Math.max(20, width - labelWidth - 9))[0] ?? ""}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/**
 * The welcome frame, ported from claude-header. The brand sits in the top
 * border like a <legend>; the left column carries the user's identity with a
 * centered Claude-style logo; the right column lists tips and "what's new".
 * A terracotta vertical separator divides them.
 */
const LOGO_BITS = [
  "000111111111111000",
  "000110111111011000",
  "011111111111111110",
  "000111111111111000",
  "000010100001010000",
] as const;

function logoLines(): string[] {
  return LOGO_BITS.map((row) =>
    row
      .split("")
      .map((b) => (b === "1" ? "█" : " "))
      .join(""),
  );
}

export function SessionHeader({
  brand,
  version,
  user = "you",
  model,
  cwd,
  tips,
  whatsNew,
}: {
  brand: string;
  version?: string;
  user?: string;
  model: string;
  cwd: string;
  tips?: readonly string[];
  whatsNew?: readonly string[];
}): React.ReactElement {
  const stdout = useStdout().stdout;
  const width = paperWidth(stdout?.columns);
  // A body row is "│ " + left + " │ " + right + " │" = left + right + 7, and
  // it must total exactly `width` to line up with the top/bottom borders.
  // Derive both panes from that budget instead of clamping each to a minimum
  // independently, which made rows overflow the frame on narrow terminals.
  const inner = Math.max(12, width - 7);
  const leftWidth = Math.max(6, Math.floor(inner * 0.45));
  const rightWidth = Math.max(6, inner - leftWidth);

  const logo = logoLines();
  const identity = [`Welcome back ${user}!`, ...logo, model, cwd];

  const defaultTips = [
    "Ask for a change, or / for commands",
    "/provider to pick a model",
    "/skills to list what's loaded",
  ];
  const tipList = tips ?? defaultTips;

  type RightKind = "heading" | "body" | "divider" | "italic";
  const right: Array<{ text: string; kind: RightKind }> = [
    { text: "Tips for getting started", kind: "heading" },
    ...tipList.map((t) => ({ text: t, kind: "body" as const })),
  ];
  if (whatsNew !== undefined && whatsNew.length > 0) {
    right.push({
      text: "─".repeat(Math.min(24, rightWidth - 2)),
      kind: "divider",
    });
    right.push({ text: "What's new", kind: "heading" });
    for (const item of whatsNew) {
      right.push({ text: item, kind: "body" });
    }
    right.push({ text: "/release-notes for more", kind: "italic" });
  }

  const naturalHeight = Math.max(identity.length, right.length);
  // Never let the frame outgrow the terminal. If it is taller than the
  // viewport the bottom is scrolled/redrawn over and the frame looks chopped,
  // so reserve room for the prompt, mode line and status bar underneath.
  const reserve = 10;
  const maxHeight = Math.max(
    3,
    (stdout?.rows !== undefined && stdout.rows > reserve ? stdout.rows : 24) - reserve,
  );
  const height = Math.min(naturalHeight, maxHeight);

  // Pre-center the left column.
  const leftRows = identity.map((line, i) => {
    const truncated =
      line.length > leftWidth ? line.slice(0, leftWidth) : line;
    const pad = Math.max(0, Math.floor((leftWidth - truncated.length) / 2));
    return { text: " ".repeat(pad) + truncated, isHeading: i === 0 };
  });

  // Truncate right column.
  const rightRows = right.map((r) => ({
    text: r.text.length > rightWidth ? r.text.slice(0, rightWidth) : r.text,
    kind: r.kind,
  }));

  const title = version === undefined ? brand : `${brand} ${version}`;
  const titlePart = `─ ${title} `;
  const topFill = Math.max(0, width - 2 - titlePart.length);
  const top = `┌${titlePart}${"─".repeat(topFill)}┐`;
  const bottom = `└${"─".repeat(Math.max(0, width - 2))}┘`;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text {...INK.accent}>{top}</Text>
      {Array.from({ length: height }).map((_, i) => {
        const left = leftRows[i];
        const rightItem = rightRows[i];
        const leftText = left !== undefined ? left.text : " ".repeat(leftWidth);
        const rightText =
          rightItem !== undefined ? rightItem.text : " ".repeat(rightWidth);
        const leftInk = left?.isHeading === true ? INK.strong : INK.dim;
        return (
          <Text key={i}>
            <Text {...INK.accent}>│ </Text>
            <Text {...leftInk}>{leftText.padEnd(leftWidth)}</Text>
            <Text {...INK.accent}> │ </Text>
            {rightItem === undefined ? (
              <Text>{" ".repeat(rightWidth)}</Text>
            ) : rightItem.kind === "heading" ? (
              <Text {...INK.accent}>{rightText.padEnd(rightWidth)}</Text>
            ) : rightItem.kind === "divider" ? (
              <Text {...INK.rail}>{rightText.padEnd(rightWidth)}</Text>
            ) : rightItem.kind === "italic" ? (
              <Text {...INK.dim}>{rightText.padEnd(rightWidth)}</Text>
            ) : (
              <Text {...INK.body}>{rightText.padEnd(rightWidth)}</Text>
            )}
            <Text {...INK.accent}> │</Text>
          </Text>
        );
      })}
      <Text {...INK.accent}>{bottom}</Text>
    </Box>
  );
}

/**
 * The "working" line, ported from claude-thinking. A slowly drifting glyph
 * and a whimsical verb in the terracotta accent, with a live elapsed timer, an
 * estimated token count, and an interrupt hint. The glyph animates so a long
 * wait reads as "thinking" rather than "stuck".
 */
export function ThinkingLine({
  verbs = THINK_VERBS,
  glyphs = THINK_FRAMES,
  showTokens = true,
}: {
  verbs?: readonly string[];
  glyphs?: readonly string[];
  showTokens?: boolean;
}): React.ReactElement {
  const [glyph, setGlyph] = useState(0);
  const [verbIdx, setVerbIdx] = useState(0);
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    const g = setInterval(() => setGlyph((x) => (x + 1) % glyphs.length), 110);
    const v = setInterval(() => setVerbIdx((x) => (x + 1) % verbs.length), 5200);
    const s = setInterval(() => setSecs((x) => x + 1), 1000);
    return () => {
      clearInterval(g);
      clearInterval(v);
      clearInterval(s);
    };
  }, [glyphs, verbs]);

  const verb = verbs[verbIdx % verbs.length] ?? "Thinking";
  const glyphNow = glyphs[glyph % glyphs.length] ?? "·";
  const tokens = showTokens ? ` · ↑ ${Math.max(0, secs * 137)} tokens` : "";

  return (
    <Box marginLeft={SPACE.contentIndent}>
      <Text>
        <Text {...INK.accent}>{glyphNow}</Text> <Text {...INK.accent}>{verb}…</Text>{" "}
        <Text {...INK.dim}>({secs}s{tokens} · esc to interrupt)</Text>
      </Text>
    </Box>
  );
}

const PROMPT_MODES: Record<
  PermissionMode,
  { glyph: string; label: string; color: string; hint: string }
> = {
  auto: {
    glyph: "⏵⏵",
    label: "auto mode on",
    color: PALETTE.warn,
    hint: "auto-approves tools · shift+tab to change",
  },
  manual: {
    glyph: "⏸",
    label: "manual mode on",
    color: PALETTE.gray,
    hint: "asks before mutating tools · shift+tab to change",
  },
  plan: {
    glyph: "⏸",
    label: "plan mode on",
    color: "#5fafaf",
    hint: "read-only, propose a plan · shift+tab to change",
  },
};

/**
 * Effort levels shown in the composer. Deliberately identical to the
 * providers' own enum (ReasoningEffort) so the value can be forwarded as-is;
 * "ultracode" was dropped because no provider accepts it.
 */
export type Effort = ReasoningEffort;

/** Cycle order for `/effort`. */
export const EFFORT_LEVELS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Next effort level, wrapping around — used when `/effort` is called bare. */
export function nextEffort(current: Effort): Effort {
  const i = EFFORT_LEVELS.indexOf(current);
  return EFFORT_LEVELS[(i + 1) % EFFORT_LEVELS.length] ?? "high";
}

/** True when `value` is one of the known effort levels. */
export function isEffort(value: string): value is Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

const EFFORTS: Record<Effort, { glyph: string; label: string }> = {
  low: { glyph: "○", label: "low" },
  medium: { glyph: "◐", label: "medium" },
  high: { glyph: "●", label: "high" },
  xhigh: { glyph: "◉", label: "xhigh" },
  max: { glyph: "◈", label: "max" },
};

/**
 * The input composer, ported from claude-prompt. A bordered well with the
 * `❯` caret inside, wrapped by rules top and bottom, an optional effort chip
 * above, and a mode line beneath that mirrors shift+tab captures.
 */
export function PromptComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  mode = "auto",
  effort,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  mode?: PermissionMode;
  effort?: Effort;
}): React.ReactElement {
  const m = PROMPT_MODES[mode];
  const e = effort !== undefined ? EFFORTS[effort] : undefined;
  return (
    <Box flexDirection="column">
      {e !== undefined ? (
        <Box justifyContent="flex-end" paddingRight={1}>
          <Text {...INK.dim}>
            {e.glyph} {e.label} · /effort
          </Text>
        </Box>
      ) : null}
      <Rule weight="light" />
      <Box>
        <Text {...INK.strong}>{MARK.prompt} </Text>
        <Box flexGrow={1}>
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            placeholder={placeholder}
          />
        </Box>
      </Box>
      <Rule weight="light" />
      <Text {...INK.dim}>
        <Text color={m.color}>{m.glyph} {m.label}</Text> {m.hint}
      </Text>
    </Box>
  );
}

/** Footer status bar: where you are, what you're talking to. */
export function StatusBar({ fields }: { fields: string[] }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Rule weight="light" />
      <Text {...INK.dim}>{fields.join(" · ")}</Text>
    </Box>
  );
}

/* ── Component library: ported, ready for a future event-wiring pass ──
 * The agent does not yet emit todo or diff events, so these are not rendered
 * by the reducer yet. They are complete, type-checked presentations that the
 * task/diff event handlers can drop straight into EntryLine when wired. */

export type TodoItem = { label: string; status: "done" | "active" | "todo" };

const TODO_ICON: Record<TodoItem["status"], string> = {
  done: "✔",
  active: "◼",
  todo: "◻",
};

/**
 * Task list, ported from claude-todo-list. The rail `⎿` precedes the first
 * check; later rows indent to keep the icons in a single column.
 */
export function TodoList({ todos }: { todos: TodoItem[] }): React.ReactElement {
  const iconColor = (s: TodoItem["status"]): string =>
    s === "done" ? PALETTE.done : s === "active" ? PALETTE.active : PALETTE.gray;

  return (
    <Box flexDirection="column" marginLeft={SPACE.contentIndent}>
      {todos.map((t, i) => (
        <Text key={i}>
          <Text color={PALETTE.gray}>
            {i === 0 ? "  ⎿ " : "    "}
          </Text>
          <Text color={iconColor(t.status)}>{TODO_ICON[t.status]} </Text>
          <Text
            {...(t.status === "done"
              ? INK.dim
              : t.status === "active"
                ? INK.strong
                : INK.body)}
          >
            {t.label}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

export type DiffRow = { type: "add" | "del" | "ctx"; n?: number; text: string };

/**
 * Inline edit hunk, ported from claude-diff. The `⏺ Update(file)` header and
 * `⎿ summary` rail match the tool-call grammar; the hunk rows carry semantic
 * +/− marks in green/red with right-aligned line numbers.
 */
export function Diff({
  file,
  summary,
  lines,
}: {
  file: string;
  summary?: string;
  lines: DiffRow[];
}): React.ReactElement {
  const numWidth = Math.max(
    ...lines.map((l) => (l.n !== undefined ? String(l.n).length : 0)),
  );
  return (
    <Box flexDirection="column" marginLeft={SPACE.contentIndent}>
      <Text>
        <Text {...INK.ok}>{MARK.toolCall} </Text>
        <Text {...INK.strong}>Update</Text>
        <Text {...INK.rail}>(</Text>
        <Text {...INK.arg}>{file}</Text>
        <Text {...INK.rail}>)</Text>
      </Text>
      {summary !== undefined ? (
        <Text>
          <Text {...INK.rail}>  {MARK.toolResult} </Text>
          <Text {...INK.dim}>{summary}</Text>
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {lines.map((l, i) => {
          const mark = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
          const markColor =
            l.type === "add"
              ? PALETTE.ok
              : l.type === "del"
                ? PALETTE.error
                : PALETTE.faint;
          const textColor = l.type === "ctx" ? PALETTE.meta : PALETTE.fg;
          const numText = l.n !== undefined ? String(l.n).padStart(numWidth) : " ".repeat(numWidth);
          return (
            <Text key={i}>
              <Text color={PALETTE.meta}>{numText} </Text>
              <Text color={markColor}>{mark} </Text>
              <Text color={textColor}>{l.text}</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
