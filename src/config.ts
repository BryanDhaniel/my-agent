import { existsSync, readFileSync } from "node:fs";

export type ProviderName = "openai" | "anthropic" | "gemini" | "glm";

export interface AgentConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
}

export const PROVIDER_NAMES: readonly ProviderName[] = [
  "openai",
  "anthropic",
  "gemini",
  "glm",
];

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
  gemini: "gemini-2.5-flash",
  glm: "glm-4.6",
};

/**
 * Env var each provider reads its key from. Nothing here is a secret — the
 * values live in the environment (or .env.local), never in source.
 */
const API_KEY_ENV: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  glm: "GLM_API_KEY",
};

export function apiKeyEnvVar(provider: ProviderName): string {
  return API_KEY_ENV[provider];
}

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * Current key for a provider, read from the environment. Sub-agents use this
 * to resolve a key for a provider other than the parent's.
 */
export function resolveApiKey(provider: ProviderName): string | undefined {
  return process.env[API_KEY_ENV[provider]];
}

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
  const provider: ProviderName =
    providerName !== undefined && providerName !== ""
      ? (providerName as ProviderName)
      : "openai";

  if (!isProviderName(provider)) {
    throw new ConfigError(
      `Unknown provider "${provider}" — expected ${PROVIDER_NAMES.join(" | ")}`,
    );
  }

  const apiKey = process.env[API_KEY_ENV[provider]];

  if (!apiKey) {
    throw new ConfigError(
      `Missing API key for ${provider}. Export ${API_KEY_ENV[provider]} and try again.`,
    );
  }

  const model =
    flags.model ?? process.env["MY_AGENT_MODEL"] ?? DEFAULT_MODELS[provider];

  return { provider, model, apiKey };
}
