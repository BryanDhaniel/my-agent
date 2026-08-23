import { Box, Text } from "ink";
import React from "react";

/**
 * Hand-rolled markdown subset renderer for assistant messages:
 * fenced code blocks, headings, bullets, **bold**, `inline code`.
 * Deliberately tiny — streaming output stays plain, only finished
 * messages get formatted.
 */
export function MarkdownLite({ text }: { text: string }): React.ReactElement {
  return <Box flexDirection="column">{renderSegments(text)}</Box>;
}

function renderSegments(text: string): React.ReactNode[] {
  const parts = text.split(/```/);
  const nodes: React.ReactNode[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    if (i % 2 === 1) {
      // code fence — first line may be a language tag
      const lines = part.split("\n");
      if (lines.length > 0 && /^[a-zA-Z0-9+#-]*$/.test(lines[0]?.trim() ?? "")) {
        lines.shift();
      }
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      for (const line of lines) {
        nodes.push(
          <Text key={`code-${nodes.length}`} color="cyan">
            │ {line}
          </Text>,
        );
      }
    } else {
      renderProse(part, nodes);
    }
  }

  return nodes;
}

function renderProse(text: string, nodes: React.ReactNode[]): void {
  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      nodes.push(
        <Text key={`h-${nodes.length}`} bold underline>
          {heading[1]}
        </Text>,
      );
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const content = bullet?.[1] ?? line;
    nodes.push(
      <Text key={`l-${nodes.length}`}>
        {bullet !== null ? "  • " : ""}
        {inline(content)}
      </Text>,
    );
  }
}

const INLINE_SPLIT = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function inline(line: string): React.ReactNode[] {
  return line.split(INLINE_SPLIT).filter((s) => s !== "").map((span, i) => {
    if (span.startsWith("**") && span.endsWith("**") && span.length > 4) {
      return <Text key={i} bold>{span.slice(2, -2)}</Text>;
    }
    if (span.startsWith("`") && span.endsWith("`") && span.length > 2) {
      return <Text key={i} color="magenta">{span.slice(1, -1)}</Text>;
    }
    return <React.Fragment key={i}>{span}</React.Fragment>;
  });
}
