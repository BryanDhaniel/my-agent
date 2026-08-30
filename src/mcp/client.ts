/**
 * MCP client wrapper — hides the MCP SDK behind a minimal interface.
 *
 * Responsibilities:
 * - Spawning MCP server processes via StdioClientTransport.
 * - Connecting, initializing, and discovering tools.
 * - Calling MCP tools.
 * - Clean shutdown.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./config.js";
import type { McpToolDescriptor } from "./adapter.js";

export class McpConnectionError extends Error {
  constructor(
    public readonly serverName: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`MCP server "${serverName}": ${message}`, options);
  }
}

export class McpClient {
  readonly serverName: string;
  #client: Client;
  #transport: StdioClientTransport;
  #tools: McpToolDescriptor[] = [];

  private constructor(
    serverName: string,
    client: Client,
    transport: StdioClientTransport,
  ) {
    this.serverName = serverName;
    this.#client = client;
    this.#transport = transport;
  }

  /**
   * Connect to an MCP server, initialize the session, and discover tools.
   * Throws McpConnectionError on failure.
   */
  static async connect(
    serverName: string,
    config: McpServerConfig,
  ): Promise<McpClient> {
    let transport: StdioClientTransport;
    try {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env
          ? { ...process.env, ...config.env } as Record<string, string>
          : undefined,
      });
    } catch (err) {
      throw new McpConnectionError(
        serverName,
        `failed to create transport: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const client = new Client(
      { name: "my-agent", version: "0.1.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
    } catch (err) {
      throw new McpConnectionError(
        serverName,
        `failed to connect: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const mcpClient = new McpClient(serverName, client, transport);
    await mcpClient.#discoverTools();
    return mcpClient;
  }

  async #discoverTools(): Promise<void> {
    try {
      const response = await this.#client.listTools();
      this.#tools = (response.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as McpToolDescriptor["inputSchema"],
      }));
    } catch (err) {
      throw new McpConnectionError(
        this.serverName,
        `tool discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  /** The tools discovered from this MCP server. */
  get tools(): readonly McpToolDescriptor[] {
    return this.#tools;
  }

  /**
   * Call a tool on this MCP server by its original (non-namespaced) name.
   * Returns the text content from the MCP response.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    try {
      const result = await this.#client.callTool({
        name: toolName,
        arguments: args,
      });

      if (result.isError) {
        const errorText = Array.isArray(result.content)
          ? result.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n")
          : String(result.content);
        return `Error: ${errorText}`;
      }

      // Extract text content from the MCP response.
      if (Array.isArray(result.content)) {
        return result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      }

      return typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content);
    } catch (err) {
      throw new Error(
        `MCP tool call "${toolName}" failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  /** Cleanly shut down the connection and the child process. */
  async close(): Promise<void> {
    try {
      await this.#client.close();
    } catch {
      // Best-effort: if close fails, we're shutting down anyway.
    }
    try {
      await this.#transport.close();
    } catch {
      // Best-effort.
    }
  }
}
