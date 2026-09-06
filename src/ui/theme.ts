/**
 * Terminal-native theme — Claude Code / opencode language.
 *
 * Hierarchy comes from weight and brightness, with a single accent hue:
 *   strong  -> bold, terminal foreground   (user input, titles, emphasis)
 *   body    -> terminal foreground         (agent prose, tool output)
 *   dim     -> gray                        (secondary labels, metadata)
 *   faint   -> dimColor                    (tertiary hints only — never
 *                                           used for anything the user must
 *                                           read; dimColor is near-invisible
 *                                           on many terminals)
 *
 * One accent (cyan) marks interactive/agent identity. Red is reserved for
 * errors, green for success, yellow for warnings. Nothing else is coloured.
 */

export const INK = {
  /** Bold terminal foreground: user input, headings, emphasis. */
  strong: { bold: true as const },
  /** Default terminal foreground. */
  body: {},
  /** Readable secondary: labels, metadata, details. */
  dim: { color: "gray" as const },
  /** Tertiary hints only. Not for content the user must read. */
  faint: { dimColor: true as const },
  /** The single accent: agent identity, active selection, prompt. */
  accent: { color: "cyan" as const },
  ok: { color: "green" as const },
  warn: { color: "yellow" as const },
  error: { color: "red" as const, bold: true as const },
} as const;

/** Glyphs. Terminal-native, no decorative corner brackets. */
export const MARK = {
  /** Input prompt and user turns. */
  prompt: "❯",
  /** Agent turns and tool activity. */
  assistant: "●",
  toolDone: "✓",
  toolFailed: "✗",
  bullet: "•",
  notice: "·",
  sessionCurrent: "●",
  sessionOther: "○",
} as const;

/** Spinner frames — braille dots, the terminal convention. */
export const DROP_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function roleLabel(role: "you" | "agent"): string {
  return role === "you" ? `${MARK.prompt} you` : `${MARK.assistant} agent`;
}

/** 留白 — gutter and rhythm. Rules are used sparingly, never as decoration. */
export const PAPER = {
  marginLeft: 3,
  maxWidth: 84,
} as const;

export const SPACE = {
  /** blank lines between Turns */
  turnGap: 1,
  /** columns of indent under a role label */
  contentIndent: 2,
} as const;

export const RULE = {
  heavy: "━",
  light: "─",
} as const;
export type RuleWeight = keyof typeof RULE;

/** Usable paper width: margins respected, capped so lines breathe. */
export function paperWidth(columns?: number): number {
  const cols = columns !== undefined && columns >= 20 ? columns : 80;
  const usable = cols - PAPER.marginLeft * 2;
  return Math.max(20, Math.min(usable, PAPER.maxWidth));
}

/** A full-width rule in the given weight. */
export function ruleLine(weight: RuleWeight, columns?: number): string {
  return RULE[weight].repeat(paperWidth(columns));
}

/** The two halves of a rule with text seated in the middle. */
export function splitRule(
  text: string,
  weight: RuleWeight,
  columns?: number,
): { left: string; right: string } {
  const width = paperWidth(columns);
  const inner = text.length + 2;
  const side = Math.max(0, Math.floor((width - inner) / 2));
  return {
    left: RULE[weight].repeat(side),
    right: RULE[weight].repeat(Math.max(0, width - inner - side)),
  };
}

/**
 * Word-wrap to the paper edge: no line of set text touches the screen wall.
 * Long words hard-break; blank lines survive as paragraph space.
 */
export function wrapPaper(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of raw.split(/\s+/)) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (candidate.length > width && current !== "") {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
      while (current.length > width) {
        lines.push(current.slice(0, width));
        current = current.slice(width);
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines;
}
