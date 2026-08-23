import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolOutput } from "../tool.js";

const inputSchema = z.object({
  path: z.string().min(1).describe("Path of the file to edit"),
  oldText: z.string().min(1).describe("Exact existing text to replace"),
  newText: z.string().describe("Replacement text"),
});

/**
 * Exact-string single replacement. Refuses ambiguous edits: if oldText
 * appears more than once the model is told to add surrounding context.
 */
export const editFileTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "edit_file",
  description:
    "Replace an exact snippet inside a file. oldText must match exactly once; include surrounding lines to disambiguate.",
  mutating: true,
  schema: inputSchema,
  ruleKey: (input) => {
    const dir = path.dirname(input.path.replace(/^\.\//, ""));
    return dir === "." ? "(project root)" : `${dir}/`;
  },

  async execute(
    input: { path: string; oldText: string; newText: string },
    _ctx: ToolContext,
  ): Promise<ToolOutput> {
    const resolved = path.resolve(_ctx.cwd, input.path);
    let content: string;
    try {
      content = await readFile(resolved, "utf8");
    } catch {
      return { output: `Error: cannot read ${input.path} (does it exist?)` };
    }

    const first = content.indexOf(input.oldText);
    if (first === -1) {
      return {
        output: `Error: oldText not found in ${input.path}. Check exact whitespace and spelling.`,
      };
    }
    if (content.indexOf(input.oldText, first + 1) !== -1) {
      return {
        output: `Error: oldText appears multiple times in ${input.path}. Add surrounding context to make it unique.`,
      };
    }

    const updated = content.slice(0, first) + input.newText + content.slice(first + input.oldText.length);
    await writeFile(resolved, updated, "utf8");
    return {
      output: `Edited ${input.path}: replaced ${input.oldText.length} chars with ${input.newText.length} chars`,
    };
  },
};
