import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolOutput } from "../tool.js";

/** Allowlist identity: the directory the write lands in. */
function pathKey(p: string): string {
  const dir = path.dirname(p.replace(/^\.\//, ""));
  return dir === "." ? "(project root)" : `${dir}/`;
}

const inputSchema = z.object({
  /** Path to write. Parent directories are created automatically. Overwrites entirely. */
  path: z.string().min(1).describe("Path of the file to write"),
  content: z.string().describe("Full new content of the file"),
});

export const writeFileTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "write_file",
  description:
    "Create or overwrite a file with the given content. Parent directories are created as needed.",
  mutating: true,
  schema: inputSchema,
  ruleKey: (input) => pathKey(input.path),

  async execute(
    input: { path: string; content: string },
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    const resolved = path.resolve(ctx.cwd, input.path);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, input.content, "utf8");
    return { output: `Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}` };
  },
};
