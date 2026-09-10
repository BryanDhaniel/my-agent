import { API_KEY_ENV, DEFAULT_MODELS, type ProviderName } from "../config.js";
import type { CredentialDefinition } from "../credentials/types.js";

/**
 * Provider and model metadata.
 *
 * This is the only place that knows which providers exist and what they are
 * called. Everything else — the setup flow, the TUI, sub-agent resolution —
 * reads from here, so adding a provider is a data change plus a case in
 * `createProvider`, not a new `if (provider === ...)` somewhere.
 *
 * There are no credentials in this file, and there never should be.
 */

export interface ModelCapabilities {
  /** Supports tool/function calling. */
  tools?: boolean;
  /** Accepts image input. */
  vision?: boolean;
  /** Reasoning-style model: slower, better at multi-step work. */
  reasoning?: boolean;
}

export interface ModelDefinition {
  id: string;
  providerId: ProviderName;
  name: string;
  contextWindow?: number;
  capabilities?: ModelCapabilities;
}

export interface ProviderDefinition {
  id: ProviderName;
  name: string;
  credential: CredentialDefinition;
  models: ModelDefinition[];
  defaultModel: string;
}

function models(
  providerId: ProviderName,
  entries: Array<[id: string, name: string, contextWindow?: number, capabilities?: ModelCapabilities]>,
): ModelDefinition[] {
  return entries.map(([id, name, contextWindow, capabilities]) => ({
    id,
    providerId,
    name,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
  }));
}

/**
 * Model ids are pinned to what each provider actually serves. They will go
 * stale before the code does, which is why `/model` prints the list from here
 * instead of the registry being consulted silently.
 */
export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "openai",
    name: "OpenAI",
    credential: {
      type: "api-key",
      environmentVariable: API_KEY_ENV.openai,
      label: "OpenAI API key",
      hint: "starts with sk-",
    },
    defaultModel: DEFAULT_MODELS.openai,
    models: models("openai", [
      ["gpt-4o", "GPT-4o", 128_000, { tools: true, vision: true }],
      ["gpt-4o-mini", "GPT-4o mini", 128_000, { tools: true, vision: true }],
      ["gpt-4.1", "GPT-4.1", 1_047_576, { tools: true, vision: true }],
      ["gpt-4.1-mini", "GPT-4.1 mini", 1_047_576, { tools: true, vision: true }],
      ["gpt-4.1-nano", "GPT-4.1 nano", 1_047_576, { tools: true, vision: true }],
    ]),
  },
  {
    id: "anthropic",
    name: "Anthropic",
    credential: {
      type: "api-key",
      environmentVariable: API_KEY_ENV.anthropic,
      label: "Anthropic API key",
    },
    defaultModel: DEFAULT_MODELS.anthropic,
    models: models("anthropic", [
      ["claude-sonnet-4-5", "Claude Sonnet 4.5", 200_000, { tools: true, vision: true }],
      ["claude-opus-4-1", "Claude Opus 4.1", 200_000, { tools: true, vision: true }],
      ["claude-3-5-haiku", "Claude 3.5 Haiku", 200_000, { tools: true }],
    ]),
  },
  {
    id: "gemini",
    name: "Gemini",
    credential: {
      type: "api-key",
      environmentVariable: API_KEY_ENV.gemini,
      label: "Gemini API key",
    },
    defaultModel: DEFAULT_MODELS.gemini,
    models: models("gemini", [
      ["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1_048_576, { tools: true, vision: true }],
      ["gemini-3.8-flash", "Gemini 3.8 Flash", 1_048_576, { tools: true, vision: true }],
    ]),
  },
  {
    id: "glm",
    name: "GLM",
    credential: {
      type: "api-key",
      environmentVariable: API_KEY_ENV.glm,
      label: "GLM API key",
    },
    defaultModel: DEFAULT_MODELS.glm,
    models: models("glm", [
      ["glm-4.6", "GLM-4.6", 200_000, { tools: true }],
      ["glm-4.5", "GLM-4.5", 128_000, { tools: true }],
      ["glm-4.5-air", "GLM-4.5 Air", 128_000, { tools: true }],
    ]),
  },
];

const BY_ID = new Map<string, ProviderDefinition>(PROVIDERS.map((p) => [p.id, p]));

export function isProviderId(value: string): value is ProviderName {
  return BY_ID.has(value);
}

export function listProviders(): readonly ProviderDefinition[] {
  return PROVIDERS;
}

export function getProvider(id: string): ProviderDefinition | undefined {
  return BY_ID.get(id);
}

/** Models for a provider, defaulting first so it is the obvious pick. */
export function listModels(providerId: string): readonly ModelDefinition[] {
  const provider = BY_ID.get(providerId);
  if (provider === undefined) return [];
  const rest = provider.models.filter((m) => m.id !== provider.defaultModel);
  const preferred = provider.models.find((m) => m.id === provider.defaultModel);
  return preferred === undefined ? rest : [preferred, ...rest];
}

export function findModel(
  providerId: string,
  modelId: string,
): ModelDefinition | undefined {
  return BY_ID.get(providerId)?.models.find((m) => m.id === modelId);
}

export function defaultModelFor(providerId: string): string | undefined {
  return BY_ID.get(providerId)?.defaultModel;
}

/**
 * Resolve a model id against a provider, falling back to the default when the
 * id is unknown (e.g. a session saved before the list changed).
 */
export function resolveModelId(providerId: string, modelId?: string): string | undefined {
  const provider = BY_ID.get(providerId);
  if (provider === undefined) return undefined;
  if (modelId !== undefined && provider.models.some((m) => m.id === modelId)) {
    return modelId;
  }
  return provider.defaultModel;
}
