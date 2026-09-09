import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolOutput } from "../tool.js";
import type { TaskOrchestrator } from "../../orchestration/orchestrator.js";
import type { OrchestrationResult } from "../../orchestration/types.js";
import { ORCHESTRATE_TOOL_NAME } from "../../subagent/manager.js";

const taskSchema = z.object({
  id: z.string().min(1).describe("Unique id inside this plan, referenced by dependencies"),
  task: z.string().min(1).describe("Self-contained description of what this task should do"),
  role: z.string().optional().describe("Role preset, e.g. researcher, coder, security-reviewer"),
  dependencies: z
    .array(z.string())
    .optional()
    .describe("Ids of tasks that must complete successfully before this one starts"),
  provider: z.string().optional().describe("Provider override (openai, anthropic, gemini, glm)"),
  model: z.string().optional().describe("Model override"),
  skills: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional().describe("Tool allowlist for this task"),
  maxTurns: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional().describe("Retries for transient failures"),
});

const inputSchema = z.object({
  tasks: z
    .array(taskSchema)
    .min(1)
    .describe("The task graph. Independent tasks run in parallel."),
  maxConcurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("How many sub-agents may run at once (default 3, max 8)"),
  failureStrategy: z
    .enum(["fail-fast", "continue"])
    .optional()
    .describe("continue (default) keeps independent tasks running after a failure"),
  timeoutMs: z.number().int().positive().optional().describe("Budget for the whole plan"),
});

export type OrchestrateInput = z.infer<typeof inputSchema>;

/**
 * Exposes orchestration through the normal Tool abstraction. The LLM supplies
 * a declarative plan; validation, scheduling and execution stay inside the
 * TaskOrchestrator.
 *
 * `mutating` is false because orchestration itself changes nothing — every
 * mutating tool a sub-agent invokes still goes through the Permission Gate.
 */
export function orchestrateTasksTool(
  orchestrator: TaskOrchestrator,
): ToolDefinition<OrchestrateInput> {
  return {
    name: ORCHESTRATE_TOOL_NAME,
    description:
      "Run a plan of related tasks as Sub-Agents. Independent tasks execute in " +
      "parallel; tasks with dependencies wait for them. Returns a concise " +
      "result per task. Use delegate_to_agent for a single self-contained task.",
    mutating: false,
    schema: inputSchema,

    async execute(input: OrchestrateInput, ctx: ToolContext): Promise<ToolOutput> {
      const result = await orchestrator.run(
        {
          tasks: input.tasks,
          ...(input.maxConcurrency !== undefined
            ? { maxConcurrency: input.maxConcurrency }
            : {}),
          ...(input.failureStrategy !== undefined
            ? { failureStrategy: input.failureStrategy }
            : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        },
        {
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          ...(ctx.modelSnapshot !== undefined
            ? {
                defaults: {
                  provider: ctx.modelSnapshot.providerId,
                  model: ctx.modelSnapshot.modelId,
                },
              }
            : {}),
        },
      );

      return { output: formatOrchestration(result) };
    },
  };
}

/** Structured digest — the parent reasons over this, not over transcripts. */
export function formatOrchestration(result: OrchestrationResult): string {
  return result.summary ?? `orchestration ${result.status}`;
}
