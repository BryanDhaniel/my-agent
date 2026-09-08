import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolOutput } from "../tool.js";

const MAX_BYTES = 256 * 1024;

const inputSchema = z.object({
  path: z.string().min(1).describe("Path of the file to read"),
});

export const readFileTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "read_file",
  description: "Read the contents of a file as UTF-8 text.",
  mutating: false,
  schema: inputSchema,

  async execute(
    input: { path: string },
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    const resolved = path.resolve(ctx.cwd, input.path);
    const info = await stat(resolved);
    if (info.isDirectory()) {
      return { output: `Error: ${input.path} is a directory` };
    }
    const maxBytes = ctx.security?.resourceLimit("fileReadBytes") ?? MAX_BYTES;
    if (info.size > maxBytes) {
      return {
        output: `Error: ${input.path} is ${info.size} bytes; over the ${maxBytes}-byte limit. Read a narrower file or use bash.`,
      };
    }
    const content = await readFile(resolved, "utf8");
    const lines = content.split("\n").length;
    return { output: `${content}\n[read_file: ${lines} lines, ${info.size} bytes]` };
  },
};
