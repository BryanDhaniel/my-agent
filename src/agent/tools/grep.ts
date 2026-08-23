import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolOutput } from "../tool.js";
import { globToRegExp } from "./glob-to-regexp.js";
import { listFiles } from "./list-files.js";

const MAX_MATCH_LINES = 100;

const inputSchema = z.object({
  pattern: z.string().min(1).describe("Regular expression to search for"),
  include: z
    .string()
    .optional()
    .describe("Only search files matching this glob, e.g. \"*.ts\""),
  ignoreCase: z.boolean().optional().describe("Case-insensitive search"),
});

export const grepTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "grep",
  description:
    "Search file contents with a regular expression across the project tree. Returns path:line matches. Use include to filter which files are searched.",
  mutating: false,
  schema: inputSchema,

  async execute(
    input: { pattern: string; include?: string; ignoreCase?: boolean },
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.ignoreCase ? "i" : "");
    } catch (err) {
      return {
        output: `Error: invalid regex — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const files = await filterFiles(ctx.cwd, input.include);
    const lines: string[] = [];
    let truncated = false;

    for (const rel of files) {
      let content: string;
      try {
        content = await readFile(resolveSafe(ctx.cwd, rel), "utf8");
      } catch {
        continue; // unreadable or binary — skip silently
      }
      if (content.includes("\0")) continue;

      const contentLines = content.split("\n");
      for (let i = 0; i < contentLines.length; i++) {
        const line = contentLines[i];
        if (line === undefined || !regex.test(line)) continue;
        if (lines.length >= MAX_MATCH_LINES) {
          truncated = true;
          break;
        }
        lines.push(`${rel}:${i + 1}: ${line.trimEnd()}`);
      }
      if (truncated) break;
    }

    if (lines.length === 0) return { output: "No matches." };
    const suffix = truncated
      ? `\n[grep stopped at ${MAX_MATCH_LINES} matches — narrow the search]`
      : "";
    return { output: lines.join("\n") + suffix };
  },
};

function resolveSafe(cwd: string, rel: string): string {
  const resolved = path.resolve(cwd, rel);
  if (!resolved.startsWith(path.resolve(cwd) + path.sep)) {
    throw new Error(`Refusing to read outside project: ${rel}`);
  }
  return resolved;
}

async function filterFiles(root: string, include?: string): Promise<string[]> {
  const files = await listFiles(root);
  if (!include) return files;
  const matcher = globToRegExp(include.replace(/^\.\//, ""));
  return files.filter(
    (f) => matcher.test(f) || matcher.test(f.split("/").pop() ?? f),
  );
}
