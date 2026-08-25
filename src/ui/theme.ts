/**
 * 水墨 theme — traditional Chinese ink wash, monochrome.
 *
 * Hierarchy comes from ink density (weight/brightness), never hue:
 *   浓 thick ink   -> bold, terminal foreground   (user, titles, emphasis)
 *   body           -> terminal foreground         (agent prose)
 *   淡 light wash  -> gray                        (secondary labels, details)
 *   faded residue  -> dimColor                    (metadata, hints)
 *
 * The single accent — vermilion, like the seal stamp (印章) on a painting —
 * belongs to exactly two things: the title stamp and errors.
 */

export const INK = {
  /** 浓 thick ink */
  strong: { bold: true as const },
  /** body ink — no overrides, respects the user's terminal palette */
  body: {},
  /** 淡 light wash */
  faint: { color: "gray" as const },
  /** faded residue */
  ghost: { dimColor: true as const },
  /** the seal — title stamp and errors, nothing else */
  seal: { color: "red" as const, bold: true as const },
} as const;

/** Brush marks and state glyphs. */
export const MARK = {
  userStroke: "▌",
  agentStroke: "▏",
  toolRunning: "⋯",
  toolDone: "✓",
  toolFailed: "✗",
  bullet: "•",
  notice: "ℹ",
  prompt: "❯",
  sessionCurrent: "●",
  sessionOther: "○",
} as const;

/** Spinner frames: an ink drop blooming on paper. */
export const DROP_FRAMES = ["·", "•", "•", "●", "•"] as const;

/** Corner-bracket label, e.g. label("sessions") -> 「sessions」 */
export function label(text: string): string {
  return `「${text}」`;
}

export function roleLabel(role: "you" | "agent"): string {
  const stroke = role === "you" ? MARK.userStroke : MARK.agentStroke;
  return `${stroke} ${label(role)}`;
}

/** 留白 — open paper: margins, rhythm, and soft rules instead of boxes. */
export const PAPER = {
  marginLeft: 3,
  maxWidth: 84,
} as const;

export const SPACE = {
  /** blank lines between Turns */
  turnGap: 2,
  /** columns of indent under a role label */
  contentIndent: 4,
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
