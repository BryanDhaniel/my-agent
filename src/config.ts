import { existsSync, readFileSync } from "node:fs";

export type ProviderName = "openai" | "anthropic";

export interface AgentConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
};

export class ConfigError extends Error {}

/**
 * Load `.env.local` then `.env` from the working directory into process.env.
 * Precedence: real environment > .env.local > .env — nothing is ever overwritten.
 */
export function loadDotenv(): void {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const [, key, raw] = match as unknown as [string, string, string];
      let value = raw;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

export function loadConfig(flags: {
  provider?: string;
  model?: string;
}): AgentConfig {
  loadDotenv();

  const providerName = flags.provider ?? process.env["MY_AGENT_PROVIDER"];
  const provider = (providerName as ProviderName | undefined) ?? "openai";

  if (provider !== "openai" && provider !== "anthropic") {
    throw new ConfigError(`Unknown provider "${provider}" — expected openai or anthropic`);
  }

  const apiKey =
    provider === "openai"
      ? process.env["OPENAI_API_KEY"]
      : process.env["ANTHROPIC_API_KEY"];

  if (!apiKey) {
    throw new ConfigError(
      `Missing API key for ${provider}. Export ${
        provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"
      } and try again.`,
    );
  }

  const model =
    flags.model ?? process.env["MY_AGENT_MODEL"] ?? DEFAULT_MODELS[provider];

  return { provider, model, apiKey };
}
