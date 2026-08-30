/**
 * Manages the lifecycle of multiple MCP client connections.
 *
 * Connects to all configured MCP servers in parallel, adapts their tools
 * into our internal ToolDefinition interface, and provides a single
 * close() to shut them all down.
 *
 * Graceful degradation: a failing server is logged and skipped, not fatal.
 */

import { McpClient, McpConnectionError } from "./client.js";
import { adaptMcpTools } from "./adapter.js";
import type { McpConfig } from "./config.js";
import type { AnyTool } from "../agent/tool.js";

export interface McpServerStatus {
  name: string;
  status: "connected" | "failed";
  toolCount: number;
  error?: string;
}

export class McpManager {
  #clients: McpClient[] = [];
  #tools: AnyTool[] = [];
  #statuses: McpServerStatus[] = [];

  private constructor() {}

  /**
   * Connect to all configured MCP servers. Servers that fail to connect
   * are reported in statuses but don't prevent others from working.
   */
  static async connectAll(config: McpConfig): Promise<McpManager> {
    const manager = new McpManager();
    const entries = Object.entries(config.servers);

    const results = await Promise.allSettled(
      entries.map(async ([name, serverConfig]) => {
        const client = await McpClient.connect(name, serverConfig);
        return { name, client };
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const serverName = entries[i]![0];

      if (result.status === "fulfilled") {
        const { client } = result.value;
        manager.#clients.push(client);

        const adapted = adaptMcpTools(
          client.serverName,
          [...client.tools],
          (toolName, args) => client.callTool(toolName, args),
        );
        manager.#tools.push(...adapted);
        manager.#statuses.push({
          name: client.serverName,
          status: "connected",
          toolCount: adapted.length,
        });
      } else {
        const errMsg =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        manager.#statuses.push({
          name: serverName,
          status: "failed",
          toolCount: 0,
          error: errMsg,
        });
      }
    }

    return manager;
  }

  /** All adapted tools from all connected MCP servers. */
  get tools(): readonly AnyTool[] {
    return this.#tools;
  }

  /** Status of each configured MCP server. */
  get statuses(): readonly McpServerStatus[] {
    return this.#statuses;
  }

  /** Number of successfully connected servers. */
  get connectedCount(): number {
    return this.#clients.length;
  }

  /** Shut down all MCP clients. Best-effort; never throws. */
  async close(): Promise<void> {
    await Promise.allSettled(
      this.#clients.map((c) => c.close()),
    );
    this.#clients = [];
    this.#tools = [];
  }
}
