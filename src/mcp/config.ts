/**
 * MCP server configuration types and loading.
 *
 * Configuration lives in `.my-agent.json` at the project root:
 *
 * ```json
 * {
 *   "mcp": {
 *     "servers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
 *       }
 *     }
 *   }
 * }
 * ```
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface McpServerConfig {
  /** Command to spawn the MCP server process. */
  command: string;
  /** Arguments passed to the command. */
  args?: string[];
  /** Extra environment variables merged into the child's env. */
  env?: Record<string, string>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

const CONFIG_FILE = ".my-agent.json";

/**
 * Load MCP configuration from `.my-agent.json` in the given directory.
 * Returns undefined when the file is absent or has no `mcp` section.
 */
export async function loadMcpConfig(cwd: string): Promise<McpConfig | undefined> {
  const filePath = path.join(cwd, CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const mcp = obj["mcp"];
  if (typeof mcp !== "object" || mcp === null) return undefined;

  const mcpObj = mcp as Record<string, unknown>;
  const servers = mcpObj["servers"];
  if (typeof servers !== "object" || servers === null) return undefined;

  // Validate each server entry has at least a `command` string.
  const validated: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry["command"] !== "string") continue;
    validated[name] = {
      command: entry["command"],
      ...(Array.isArray(entry["args"]) ? { args: entry["args"].map(String) } : {}),
      ...(typeof entry["env"] === "object" && entry["env"] !== null
        ? { env: Object.fromEntries(Object.entries(entry["env"] as Record<string, unknown>).map(([k, v]) => [k, String(v)])) }
        : {}),
    };
  }

  if (Object.keys(validated).length === 0) return undefined;
  return { servers: validated };
}
