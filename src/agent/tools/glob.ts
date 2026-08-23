import path from "node:path";
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolOutput } from "../tool.js";
import { globToRegExp } from "./glob-to-regexp.js";
import { listFiles } from "./list-files.js";

const MAX_RESULTS = 200;

const inputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      'Glob pattern relative to the project root, e.g. "src/**/*.ts" or "*.json"',
    ),
});

export const globTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "glob",
  description:
    "Find files by glob pattern (supports ** across directories). Returns up to 200 relative paths.",
  mutating: false,
  schema: inputSchema,

  async execute(
    input: { pattern: string },
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    const matcher = globToRegExp(input.pattern.replace(/^\.\//, ""));
    const files = await listFiles(ctx.cwd);
    const matches = files.filter((f) => matcher.test(f)).slice(0, MAX_RESULTS);

    if (matches.length === 0) {
      return { output: `No files match ${input.pattern}` };
    }

    const suffix =
      files.filter((f) => matcher.test(f)).length > MAX_RESULTS
        ? `\n[glob: showing first ${MAX_RESULTS} matches]`
        : "";
    return { output: matches.map((m) => `./${m}`).join("\n") + suffix };
  },
};
