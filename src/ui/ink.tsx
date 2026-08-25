import { Box, Text, useStdout } from "ink";
import React, { useEffect, useState } from "react";
import TextInput from "ink-text-input";
import type { PermissionRequest } from "../permissions/gate.js";
import type { SlashCommand } from "./commands.js";
import type { NoticeView, ToolView } from "./view.js";
import {
  DROP_FRAMES,
  INK,
  MARK,
  PAPER,
  RULE,
  SPACE,
  label,
  paperWidth,
  roleLabel,
  ruleLine,
  splitRule,
  wrapPaper,
} from "./theme.js";

/**
 * The presentation seam. Components express intent ("this is an error",
 * "this is a role block"); every density, glyph, margin, and weight decision
 * lives here, fed by theme.ts. Callers never touch tokens directly.
 */

/** The page itself: margins so text never touches the screen wall. */
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

/** Full-width rule across the usable paper width. */
export function Rule({
  weight,
}: {
  weight: keyof typeof RULE;
}): React.ReactElement {
  const { stdout } = useStdout();
  return <Text {...INK.faint}>{ruleLine(weight, stdout?.columns)}</Text>;
}

/** The seal — vermilion title seated in a heavy rule, centered on the page. */
export function SealHeader(): React.ReactElement {
  const { stdout } = useStdout();
  const { left, right } = splitRule("my-agent", "heavy", stdout?.columns);
  return (
    <Box marginBottom={1}>
      <Text>
        <Text {...INK.faint}>{left}</Text>
        <Text {...INK.seal}> my-agent </Text>
        <Text {...INK.faint}>{right}</Text>
      </Text>
    </Box>
  );
}

function useContentWidth(): number {
  const { stdout } = useStdout();
  return paperWidth(stdout?.columns) - SPACE.contentIndent;
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

/** A spoken block: thick stroke for you, thin stroke for the agent. */
export function RoleBlock({
  role,
  children,
}: {
  role: "you" | "agent";
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text {...(role === "you" ? INK.strong : {})}>{roleLabel(role)}</Text>
      <Box marginLeft={SPACE.contentIndent}>{children}</Box>
    </Box>
  );
}

export function ErrorLine({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box marginLeft={SPACE.contentIndent}>
      <Text {...INK.seal}>
        {MARK.toolFailed} {children}
      </Text>
    </Box>
  );
}

export function NoticeLine({ text }: { text: string }): React.ReactElement {
  return (
    <Box marginLeft={SPACE.contentIndent}>
      <Text {...INK.ghost}>
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
        {" "}
        <Text {...INK.faint}>
          {MARK.toolRunning} {entry.toolName}
        </Text>{" "}
        <Text {...INK.ghost}>{entry.detail}…</Text>
      </Text>
    );
  } else if (entry.status === "denied") {
    head = (
      <Text>
        {" "}
        <Text inverse>{MARK.toolFailed}</Text>{" "}
        <Text {...INK.faint}>{entry.toolName}</Text>{" "}
        <Text {...INK.ghost}>{entry.detail}</Text>
      </Text>
    );
  } else {
    head = (
      <Text>
        {" "}
        <Text>{MARK.toolDone}</Text> <Text {...INK.faint}>{entry.toolName}</Text>{" "}
        <Text {...INK.ghost}>{entry.detail}</Text>
      </Text>
    );
  }

  const outputLines =
    verbose && entry.output !== undefined && entry.output !== ""
      ? wrapPaper(entry.output.split("\n").slice(-VERBOSE_MAX_LINES).join("\n"), paperWidth(stdout?.columns))
      : [];

  return (
    <Box flexDirection="column">
      {head}
      {outputLines.length > 0 && (
        <>
          <Text {...INK.faint}>{ruleLine("light", stdout?.columns)}</Text>
          {outputLines.map((line, i) =>
            line === "" ? (
              <Text key={i}> </Text>
            ) : (
              <Text key={`o-${i}`} {...INK.faint}>
                {" ".repeat(SPACE.contentIndent)}
                {line}
              </Text>
            ),
          )}
          <Text {...INK.faint}>{ruleLine("light", stdout?.columns)}</Text>
        </>
      )}
    </Box>
  );
}

/** Permission Gate prompt framed by soft rules instead of a box. */
export function PermissionBlock({
  request,
}: {
  request: PermissionRequest;
}): React.ReactElement {
  const { stdout } = useStdout();
  return (
    <Box flexDirection="column" marginY={1}>
      <Rule weight="heavy" />
      <Box marginLeft={SPACE.contentIndent} marginY={1}>
        <Text>
          <Text {...INK.strong}>{label("permission")} </Text>
          {MARK.prompt} allow{" "}
          <Text {...INK.strong}>{request.summary}</Text>?{" "}
          <Text {...INK.ghost}>
            [y] yes / [n] no
            {request.ruleKey !== undefined
              ? ` / [a] always (${request.toolName} · ${request.ruleKey})`
              : ""}
          </Text>
        </Text>
      </Box>
      <Rule weight="light" />
    </Box>
  );
}

/** Spinner: an ink drop blooming on paper. */
export function InkDropSpinner({
  label: text,
}: {
  label: string;
}): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % DROP_FRAMES.length), 220);
    return () => clearInterval(timer);
  }, []);
  return (
    <Box marginLeft={SPACE.contentIndent}>
      <Text>
        <Text bold>{DROP_FRAMES[frame]}</Text> <Text {...INK.ghost}>{text}</Text>
      </Text>
    </Box>
  );
}

export function SuggestionList({
  commands,
  selected,
}: {
  commands: SlashCommand[];
  selected: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginLeft={SPACE.contentIndent} marginBottom={1}>
      {commands.map((command, i) => (
        <Text key={command.name}>
          <Text inverse={i === selected} {...INK.strong}>
            {`/${command.name}`.padEnd(11)}
          </Text>
          <Text {...INK.ghost}> {command.description}</Text>
        </Text>
      ))}
      <Text {...INK.ghost}> ↑/↓ select · tab complete · enter run</Text>
    </Box>
  );
}

/** Quiet guidance when the Session is still blank. */
export function EmptyPaper(): React.ReactElement {
  const { stdout } = useStdout();
  const width = paperWidth(stdout?.columns);
  const center = (text: string): string =>
    text.padStart(Math.max(0, Math.floor((width - PAPER.marginLeft * 2 + text.length) / 2)));
  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text {...INK.ghost}>{center("the paper is blank")}</Text>
      <Text {...INK.ghost}>
        {center('try /help · or ask: "outline this project"')}
      </Text>
      <Text> </Text>
    </Box>
  );
}
