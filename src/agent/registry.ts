import { z } from "zod";
import { zodToJsonSchema } from "./json-schema.js";
import type {
  AnyTool,
  ToolContext,
  ToolOutput,
  ToolSpec,
} from "./tool.js";

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
  }
}

export class ToolArgumentError extends Error {}

/**
 * Holds the Tools the model may request, validates arguments against each
 * tool's schema, and produces the wire-format specs for Providers.
 */
export class ToolRegistry {
  #tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  /** Register multiple tools at once. */
  registerAll(tools: AnyTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  list(): AnyTool[] {
    return [...this.#tools.values()];
  }

  get(name: string): AnyTool | undefined {
    return this.#tools.get(name);
  }

  /** Validate arguments without executing. */
  parse(
    name: string,
    argumentsJson: string,
  ): { ok: true; data: unknown } | { ok: false; error: string } {
    const tool = this.#tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
    let input: unknown;
    try {
      input = JSON.parse(argumentsJson || "{}");
    } catch {
      return { ok: false, error: "tool arguments were not valid JSON" };
    }
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, error: `invalid arguments — ${issues}` };
    }
    return { ok: true, data: parsed.data };
  }

  /** Validate arguments and execute; never throws — failures become outputs. */
  async invoke(
    name: string,
    argumentsJson: string,
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    const tool = this.#tools.get(name);
    if (!tool) {
      return { output: `Error: ${new UnknownToolError(name).message}` };
    }

    let input: unknown;
    try {
      input = JSON.parse(argumentsJson || "{}");
    } catch {
      return { output: "Error: tool arguments were not valid JSON" };
    }

    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { output: `Error: invalid arguments — ${issues}` };
    }

    try {
      return await tool.execute(parsed.data, ctx);
    } catch (err) {
      return {
        output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  specs(): ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.schema),
    }));
  }
}
