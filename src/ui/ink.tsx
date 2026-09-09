import { Box, Text, useStdout } from "ink";
import React, { useEffect, useState } from "react";
import type { PermissionRequest } from "../permissions/gate.js";
import type { SlashCommand } from "./commands.js";
import type { NoticeView, PanelView, ToolView } from "./view.js";
import {
  DROP_FRAMES,
  INK,
  MARK,
  PAPER,
  RULE,
  SPACE,
  paperWidth,
  roleLabel,
  ruleLine,
  wrapPaper,
} from "./theme.js";

/**
 * The presentation seam. Components express intent ("this is an error",
 * "this is a role block"); every density, glyph, margin, and weight decision
 * lives here, fed by theme.ts. Callers never touch tokens directly.
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
  return <Text {...INK.faint}>{ruleLine(weight, stdout?.columns)}</Text>;
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
export function PaperText({ text }: { text: string }): React.ReactElement {
  const width = useContentWidth();
  return (
    <Box flexDirection="column">
      {wrapPaper(text, Math.max(20, width)).map((line, i) =>
        line === "" ? <Text key={i}> </Text> : <Text key={i}>{line}</Text>,
      )}
    </Box>
  );
}

/** A spoken turn. The user is bold input; the agent carries the accent. */
export function RoleBlock({
  role,
  children,
}: {
  role: "you" | "agent";
  children: React.ReactNode;
}): React.ReactElement {
  const isUser = role === "you";
  return (
    <Box flexDirection="column">
      <Text {...(isUser ? INK.strong : INK.accent)}>{roleLabel(role)}</Text>
      <Box marginLeft={SPACE.contentIndent}>{children}</Box>
    </Box>
  );
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

const VERBOSE_MAX_LINES = 40;

/** One Tool status line; unfolds its full Tool Result in verbose mode. */
export function ToolStatusLine({
  entry,
  verbose,
}: {
  entry: ToolView;
  verbose: boolean;
}): React.ReactElement {
  const { stdout } = useStdout();

  let head: React.ReactElement;
  if (entry.status === "running") {
    head = (
      <Text>
        <Text {...INK.accent}>{MARK.assistant} </Text>
        <Text {...INK.strong}>{entry.toolName}</Text>
        <Text {...INK.dim}> {entry.detail}…</Text>
      </Text>
    );
  } else if (entry.status === "denied") {
    head = (
      <Text>
        <Text {...INK.error}>{MARK.toolFailed} </Text>
        <Text {...INK.strong}>{entry.toolName}</Text>
        <Text {...INK.dim}> {entry.detail}</Text>
      </Text>
    );
  } else {
    head = (
      <Text>
        <Text {...INK.ok}>{MARK.toolDone} </Text>
        <Text {...INK.strong}>{entry.toolName}</Text>
        <Text {...INK.dim}> {entry.detail}</Text>
      </Text>
    );
  }

  const outputLines =
    verbose && entry.output !== undefined && entry.output !== ""
      ? wrapPaper(
          entry.output.split("\n").slice(-VERBOSE_MAX_LINES).join("\n"),
          paperWidth(stdout?.columns),
        )
      : [];

  return (
    <Box flexDirection="column" marginLeft={SPACE.contentIndent}>
      {head}
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

/** Permission Gate prompt. */
export function PermissionBlock({
  request,
}: {
  request: PermissionRequest;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginY={1}>
      <Rule weight="heavy" />
      <Box marginLeft={SPACE.contentIndent} marginY={1}>
        <Text>
          <Text {...INK.warn}>{MARK.assistant} allow </Text>
          <Text {...INK.strong}>{request.summary}</Text>
          <Text {...INK.warn}>?</Text>{" "}
          <Text {...INK.dim}>
            [y] yes / [n] no
            {request.ruleKey !== undefined
              ? ` / [a] always (${request.toolName} ${request.ruleKey})`
              : ""}
          </Text>
        </Text>
      </Box>
      <Rule weight="light" />
    </Box>
  );
}

/** Braille spinner — the terminal convention. */
export function Spinner({ label }: { label: string }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % DROP_FRAMES.length), 80);
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
        <Text {...{ bold: true, color: "cyan" }}>{MARK.prompt} </Text>
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
 * Opening screen. Deliberately quiet — one line, no command dump.
 * Commands stay discoverable by typing "/", not by cluttering the start.
 */
export function Welcome(): React.ReactElement {
  return (
    <Box flexDirection="column" marginLeft={SPACE.contentIndent}>
      <Text {...INK.dim}>A coding agent in your terminal.</Text>
    </Box>
  );
}

/** Footer status bar: where you are, what you're talking to. */
export function StatusBar({
  fields,
}: {
  fields: string[];
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Rule weight="light" />
      <Text {...INK.dim}>{fields.join(" · ")}</Text>
    </Box>
  );
}
