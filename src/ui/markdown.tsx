import { Box, Text, useStdout } from "ink";
import React from "react";
import { INK, MARK, SPACE, paperWidth, ruleLine, wrapPaper } from "./theme.js";

/**
 * Hand-rolled markdown subset renderer for assistant messages:
 * fenced code blocks, headings, nested bullets, blockquotes, horizontal
 * rules, **bold**, `inline code`. Deliberately tiny.
 *
 * Streaming output renders through this same code path; a stream that ends
 * inside an open ``` fence is treated as a live code block instead of
 * flickering between prose and code.
 */
export function MarkdownLite({ text }: { text: string }): React.ReactElement {
  const { stdout } = useStdout();
  return (
    <Box flexDirection="column">{renderSegments(text, stdout?.columns)}</Box>
  );
}

function renderSegments(
  text: string,
  columns: number | undefined,
): React.ReactNode[] {
  const parts = text.split(/```/);
  // odd part count => the stream stopped inside an unclosed fence
  const unclosedTail = parts.length > 1 && parts.length % 2 === 1;
  const nodes: React.ReactNode[] = [];
  const width = Math.max(20, paperWidth(columns) - SPACE.contentIndent);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;

    const isCode = i % 2 === 1 || (unclosedTail && i === parts.length - 1);
    if (!isCode) {
      renderProse(part, nodes, columns);
      continue;
    }

    // code fence — first line may be a language tag
    const lines = part.split("\n");
    if (lines.length > 0 && /^[a-zA-Z0-9+#-]*$/.test(lines[0]?.trim() ?? "")) {
      lines.shift();
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    nodes.push(
      <Text key={`open-${nodes.length}`} {...INK.faint}>
        {ruleLine("light", columns)}
      </Text>,
    );
    for (const line of lines) {
      for (const wrapped of wrapPaper(line.replace(/\t/g, "  "), width)) {
        nodes.push(
          <Text key={`code-${nodes.length}`} {...INK.faint}>
            {" ".repeat(SPACE.contentIndent)}
            {wrapped}
          </Text>,
        );
      }
    }
    nodes.push(
      <Text key={`close-${nodes.length}`} {...INK.faint}>
        {ruleLine("light", columns)}
      </Text>,
    );
  }

  return nodes;
}

function renderProse(
  text: string,
  nodes: React.ReactNode[],
  columns: number | undefined,
): void {
  const width = Math.max(20, paperWidth(columns) - SPACE.contentIndent);
  const lines = text.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      nodes.push(<Text key={`p-${nodes.length}`}> </Text>);
      continue;
    }

    // markdown horizontal rule -> a real rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      nodes.push(
        <Box key={`hr-${nodes.length}`} marginY={1}>
          <Text {...INK.faint}>{ruleLine("light", columns)}</Text>
        </Box>,
      );
      continue;
    }

    // blockquote -> faint indented wash
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      for (const chunk of wrapPaper(quote[1] ?? "", width - 4)) {
        nodes.push(
          <Text key={`q-${nodes.length}`} {...INK.faint}>
            {" ".repeat(SPACE.contentIndent + 2)}
            {chunk}
          </Text>,
        );
      }
      continue;
    }

    // heading -> thick-stroke lead
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      nodes.push(
        <Box key={`h-${nodes.length}`} marginY={1}>
          <Text {...INK.strong}>
            ━━ {heading[1]}
          </Text>
        </Box>,
      );
      continue;
    }

    // lists nest by leading whitespace: 2 spaces per level
    let prefix = "";
    let content = line;
    const listMatch = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      const level = Math.floor((listMatch[1]?.length ?? 0) / 2);
      const marker = listMatch[2] ?? "";
      prefix = `${"  ".repeat(level)}${/[-*]/.test(marker) ? `${MARK.bullet} ` : `${marker} `}`;
      content = listMatch[3] ?? "";
    }

    const chunks = wrapPaper(content, Math.max(20, width - prefix.length - 4));
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      if (chunk === undefined) continue;
      nodes.push(
        <Text key={`l-${nodes.length}-${ci}`}>
          {ci === 0 ? prefix : `${prefix}  `}
          {inline(chunk)}
        </Text>,
      );
    }
  }
}

const INLINE_SPLIT = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function inline(line: string): React.ReactNode[] {
  return line
    .split(INLINE_SPLIT)
    .filter((s) => s !== "")
    .map((span, i) => {
      if (span.startsWith("**") && span.endsWith("**") && span.length > 4) {
        return (
          <Text key={i} {...INK.strong}>
            {span.slice(2, -2)}
          </Text>
        );
      }
      if (span.startsWith("`") && span.endsWith("`") && span.length > 2) {
        return (
          <Text key={i} {...INK.faint}>
            {span}
          </Text>
        );
      }
      return <React.Fragment key={i}>{span}</React.Fragment>;
    });
}
