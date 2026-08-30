/**
 * Converts MCP tool descriptors into our internal ToolDefinition interface.
 *
 * The adapted tools are indistinguishable from native tools:
 * - `name` is namespaced as `mcp.<server>.<toolName>` to prevent collisions.
 * - `schema` uses a Zod passthrough for the MCP JSON Schema.
 * - `mutating: true` — MCP tools always go through the Permission Gate.
 * - `execute()` delegates to the provided `callTool` function.
 */

import { z } from "zod";
import type { AnyTool, ToolContext, ToolOutput } from "../agent/tool.js";

/** The subset of an MCP tool descriptor we need. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** Function signature for calling an MCP tool by name. */
export type McpCallToolFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string>;

/**
 * Adapt a batch of MCP tool descriptors into our internal ToolDefinition
 * interface, namespaced under the given server name.
 */
export function adaptMcpTools(
  serverName: string,
  tools: McpToolDescriptor[],
  callTool: McpCallToolFn,
): AnyTool[] {
  return tools.map((descriptor) =>
    adaptOne(serverName, descriptor, callTool),
  );
}

function adaptOne(
  serverName: string,
  descriptor: McpToolDescriptor,
  callTool: McpCallToolFn,
): AnyTool {
  const qualifiedName = `mcp.${serverName}.${descriptor.name}`;

  // MCP tools define JSON Schema, not Zod. We use a passthrough schema
  // that accepts any object — the MCP server validates on its side.
  const schema = z.record(z.string(), z.unknown()).optional().transform(
    (val) => (val ?? {}) as Record<string, unknown>,
  );

  return {
    name: qualifiedName,
    description: descriptor.description ?? `MCP tool: ${descriptor.name} (${serverName})`,
    mutating: true,
    schema: schema as z.ZodType<unknown>,

    async execute(input: unknown, _ctx: ToolContext): Promise<ToolOutput> {
      const args =
        typeof input === "object" && input !== null
          ? (input as Record<string, unknown>)
          : {};
      try {
        const output = await callTool(descriptor.name, args);
        return { output };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return { output: `Error calling MCP tool "${qualifiedName}": ${message}` };
      }
    },
  };
}
