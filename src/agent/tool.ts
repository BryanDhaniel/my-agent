import type { z } from "zod";

/** What a Tool needs from the environment when it executes. */
export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /**
   * The security boundary that already authorized this call.
   *
   * Tools use it to read resource limits and to build a filtered environment;
   * they never use it to re-litigate the decision the runtime already made.
   */
  security?: import("../security/manager.js").SecurityManager;
  /**
   * Provider/model the current run started with. Delegation and orchestration
   * inherit it unless told otherwise, so a mid-run switch cannot retarget
   * work already in progress.
   */
  modelSnapshot?: import("../providers/snapshot.js").ModelSnapshot;
}

export interface ToolOutput {
  /** Machine-facing result text fed back to the model as the Tool Result. */
  output: string;
}

export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
  /** Mutating tools go through the Permission Gate before executing. */
  mutating: boolean;
  /**
   * Identity used by the session allowlist: approving "always" for one key
   * approves every future call with the same key this session.
   * e.g. run_bash -> first command token, file tools -> parent directory.
   * Absent means the tool cannot be allowlisted (every call prompts).
   */
  ruleKey?(input: T): string;
  execute(input: T, ctx: ToolContext): Promise<ToolOutput>;
}

export type AnyTool = ToolDefinition<unknown>;

/** Structural description handed to Providers (they convert to vendor shapes). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
