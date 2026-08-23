import { exec } from "node:child_process";
import type { ToolContext, ToolDefinition, ToolOutput } from "../tool.js";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 10_000;

const inputSchema = z.object({
  command: z.string().min(1).describe("The shell command to run"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`),
});

function truncate(label: string, text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[${label} truncated at ${MAX_OUTPUT_CHARS} chars]`
    : text;
}

export const runBashTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "run_bash",
  description:
    "Run a shell command in the project directory and see its output. Use for builds, tests, git status, listing files, etc.",
  mutating: true,
  schema: inputSchema,
  /** Allowlist identity: the program being invoked (first command token). */
  ruleKey: (input) => input.command.trim().split(/\s+/)[0] ?? input.command,

  async execute(
    input: { command: string; timeoutMs?: number },
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (resolve) => {
        exec(
          input.command,
          {
            cwd: ctx.cwd,
            timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, NO_COLOR: "1" },
          },
          (error, stdout, stderr) => {
            resolve({
              stdout: stdout.toString(),
              stderr: stderr.toString(),
              code: error ? (typeof error.code === "number" ? error.code : null) : 0,
            });
          },
        );
      },
    );

    const parts = [`exit code: ${result.code ?? "signal"}`];
    if (result.stdout.trim()) parts.push(`stdout:\n${truncate("stdout", result.stdout.trimEnd())}`);
    if (result.stderr.trim()) parts.push(`stderr:\n${truncate("stderr", result.stderr.trimEnd())}`);
    return { output: parts.join("\n") };
  },
};
