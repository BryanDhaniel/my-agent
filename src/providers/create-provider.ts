import type { AgentConfig } from "../config.js";
import type { Provider } from "./provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { GLMProvider } from "./glm.js";
import { OpenAIProvider } from "./openai.js";

export class UnknownProviderError extends Error {
  constructor(provider: string) {
    super(`Unknown provider "${provider}"`);
    this.name = "UnknownProviderError";
  }
}

/**
 * The one place a Provider is constructed.
 *
 * The switch is exhaustive over ProviderName and the default branch is typed
 * `never`, so adding a fifth provider becomes a compile error here and
 * requires no change anywhere else. The Agent and Harness depend on the
 * Provider interface only.
 */
export function createProvider(config: AgentConfig): Provider {
  switch (config.provider) {
    case "openai":
      return new OpenAIProvider(config.apiKey, config.model);
    case "anthropic":
      return new AnthropicProvider(config.apiKey, config.model);
    case "gemini":
      return new GeminiProvider(config.apiKey, config.model);
    case "glm":
      return new GLMProvider(config.apiKey, config.model);
    default: {
      const unreachable: never = config.provider;
      throw new UnknownProviderError(String(unreachable));
    }
  }
}
