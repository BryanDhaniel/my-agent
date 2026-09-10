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

/**
 * Concrete values behind the semantic tokens below.
 *
 * Terminals resolve named colours through the user's theme, so the two hues
 * that carry meaning — the terracotta accent and the cyan used for
 * identifiers — are pinned to hex. Everything else stays semantic (bold,
 * gray, dimColor) so it still respects the terminal's own palette.
 */
export const PALETTE = {
  fg: "#c0caf5",
  /** The single accent: agent identity, active rows, frames. */
  brand: "#cd694a",
  brandHilite: "#e79475",
  gray: "#949494",
  /** Secondary text: tool results, metadata. */
  meta: "#8b8fa3",
  /** Structural glyphs: rails, parens. Never content. */
  faint: "#565f89",
  ok: "#4ea96f",
  done: "#87d787",
  active: "#d78787",
  error: "#f7768e",
  warn: "#e0af68",
  /** Identifiers in a tool call: paths, commands, model ids. */
  arg: "#7dcfff",
} as const;

export const INK = {
  /** Bold terminal foreground: user input, headings, emphasis. */
  strong: { bold: true as const },
  /** Default terminal foreground. */
  body: {},
  /** Readable secondary: labels, metadata, details. */
  dim: { color: "gray" as const },
  /** Tertiary hints only. Not for content the user must read. */
  faint: { dimColor: true as const },
  /** The single accent: agent identity, active selection, prompt, frames. */
  accent: { color: PALETTE.brand },
  /** Identifiers inside a tool call: paths, commands, model ids. */
  arg: { color: PALETTE.arg },
  /** Structural glyphs (⎿ rails, parens). Not readable content. */
  rail: { color: PALETTE.faint },
  ok: { color: PALETTE.ok },
  warn: { color: PALETTE.warn },
  error: { color: PALETTE.error, bold: true as const },
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
  /** Tool rail: the call sits on ⏺, its result on ⎿. */
  toolCall: "⏺",
  toolResult: "⎿",
  /** Active row in a picker or permission list. */
  selector: "❯",
} as const;

/** Spinner frames — braille dots, the terminal convention. */
export const DROP_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/**
 * Thinking frames and verbs: a slow drifting glyph rather than a fast
 * spinner, so a long wait reads as "working" instead of "panicking".
 */
export const THINK_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"] as const;
export const THINK_VERBS = [
  "Thinking",
  "Percolating",
  "Noodling",
  "Conjuring",
  "Herding",
  "Rummaging",
] as const;

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
 * A bordered box with its title seated in the top edge — the terminal
 * equivalent of a <fieldset>/<legend>. Pure strings, so callers can pad,
 * colour and compose rows without knowing how the frame is drawn.
 *
 * ┌─ title ──────────┐
 * │ row              │
 * └──────────────────┘
 */
export function frameBox(
  title: string,
  rows: readonly string[],
  width: number,
): string[] {
  const w = Math.max(20, width);
  const inner = w - 4;

  const label = title === "" ? "" : `─ ${title} `;
  const topFill = Math.max(0, w - 2 - label.length);
  const top = `┌${label}${"─".repeat(topFill)}┐`;

  const bottom = `└${"─".repeat(Math.max(0, w - 2))}┘`;

  const body = rows.map((row) => {
    const clipped = row.length > inner ? `${row.slice(0, Math.max(0, inner - 1))}…` : row;
    return `│ ${clipped.padEnd(inner)} │`;
  });

  return [top, ...body, bottom];
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
