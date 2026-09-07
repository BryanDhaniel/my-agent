import type OpenAI from "openai";
import type { ChatMessage } from "../agent/types.js";
import type { Provider, StreamEvent, StreamOptions } from "./provider.js";
import { OpenAIProvider } from "./openai.js";

/**
 * Zhipu AI GLM.
 *
 * GLM exposes an OpenAI-compatible chat completions API, so this provider is
 * a thin adapter over the same transport rather than a second HTTP client:
 * same message/tool/streaming translation, different endpoint and key.
 * Override the endpoint with GLM_BASE_URL (e.g. a self-hosted gateway).
 */
export const GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

export class GLMProvider implements Provider {
  readonly name = "glm";
  readonly model: string;
  #inner: OpenAIProvider;

  constructor(
    apiKey: string,
    model: string,
    baseURL: string = process.env["GLM_BASE_URL"] ?? GLM_BASE_URL,
    client?: OpenAI,
  ) {
    this.#inner = new OpenAIProvider(apiKey, model, baseURL, client);
    this.model = model;
  }

  stream(
    messages: ChatMessage[],
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    return this.#inner.stream(messages, options);
  }
}
