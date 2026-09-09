import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolOutput } from "../tool.js";
import { DELEGATE_TOOL_NAME, type SubAgentManager } from "../../subagent/manager.js";
import { roleNames } from "../../subagent/roles.js";
import { inheritSnapshot } from "../../providers/snapshot.js";
import type { SubAgentResult } from "../../subagent/types.js";

const inputSchema = z.object({
  task: z
    .string()
    .min(1)
    .describe("Self-contained task for the sub-agent. Include everything it needs to know."),
  role: z
    .string()
    .optional()
    .describe(`Role preset: ${roleNames().join(", ")}. Defaults to "general".`),
  provider: z
    .string()
    .optional()
    .describe("Provider override (openai, anthropic, gemini, glm). Inherits the parent's when omitted."),
  model: z.string().optional().describe("Model override. Inherits the parent's when omitted."),
  skills: z.array(z.string()).optional().describe("Skill names to load into the sub-agent."),
  tools: z.array(z.string()).optional().describe("Tool allowlist. Defaults to the role's allowlist."),
  maxTurns: z.number().int().positive().optional().describe("Maximum agent turns."),
  timeoutMs: z.number().int().positive().optional().describe("Timeout in milliseconds."),
  relevantContext: z
    .string()
    .optional()
    .describe("Background the sub-agent cannot infer from the task alone."),
  files: z.array(z.string()).optional().describe("Files the sub-agent should look at."),
  constraints: z.array(z.string()).optional().describe("Hard rules for this delegation."),
});

export type DelegateInput = z.infer<typeof inputSchema>;

/**
 * Exposes delegation through the normal Tool abstraction, so the LLM decides
 * when a sub-agent is useful. The parent only ever sees the structured
 * result — never the child's transcript or runtime.
 *
 * `mutating` is false because delegation itself changes nothing: every
 * mutating tool the child invokes still goes through the Permission Gate.
 */
export function delegateToAgentTool(
  manager: SubAgentManager,
): ToolDefinition<DelegateInput> {
  return {
    name: DELEGATE_TOOL_NAME,
    description:
      "Delegate a self-contained task to a Sub-Agent with its own context, tools " +
      "and (optionally) its own model. Returns a concise structured result.",
    mutating: false,
    schema: inputSchema,

    async execute(input: DelegateInput, ctx: ToolContext): Promise<ToolOutput> {
      const result = await manager.run(
        {
          task: input.task,
          ...(input.role !== undefined ? { role: input.role } : {}),
          // Inherit the parent's snapshot unless this call chose otherwise.
          ...inheritSnapshot(ctx.modelSnapshot, {
            ...(input.provider !== undefined ? { provider: input.provider } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
          }),
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
          ...(input.tools !== undefined ? { tools: input.tools } : {}),
          ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        },
        {
          context: {
            ...(input.relevantContext !== undefined
              ? { relevantContext: input.relevantContext }
              : {}),
            ...(input.files !== undefined ? { files: input.files } : {}),
            ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
          },
          signal: ctx.signal,
        },
      );

      return { output: formatResult(result) };
    },
  };
}

/** Compact, structured handoff — deliberately not the child's transcript. */
export function formatResult(result: SubAgentResult): string {
  const lines: string[] = [`sub-agent ${result.status}`];
  if (result.role !== undefined) lines.push(`role: ${result.role}`);
  if (result.provider !== undefined || result.model !== undefined) {
    lines.push(`model: ${result.provider ?? "?"} / ${result.model ?? "?"}`);
  }
  if (result.turns !== undefined) lines.push(`turns: ${result.turns}`);
  lines.push("");
  lines.push(result.summary);

  if (result.actionsTaken !== undefined && result.actionsTaken.length > 0) {
    lines.push("", `tools used: ${result.actionsTaken.join(", ")}`);
  }
  if (result.filesChanged !== undefined && result.filesChanged.length > 0) {
    lines.push(`files changed: ${result.filesChanged.join(", ")}`);
  }
  if (result.errors !== undefined && result.errors.length > 0) {
    lines.push("", `errors:\n${result.errors.map((e) => `- ${e}`).join("\n")}`);
  }
  return lines.join("\n");
}
