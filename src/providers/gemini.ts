import { GoogleGenAI, type GenerateContentConfig } from "@google/genai";
import type { AssistantMessage, ChatMessage } from "../agent/types.js";
import type { Provider, StreamEvent, StreamOptions } from "./provider.js";
import {
  GeminiCallAccumulator,
  toGeminiRequest,
  toGeminiTools,
} from "./gemini-mapping.js";

/**
 * Google Gemini, via the official `@google/genai` SDK.
 *
 * Everything Gemini-specific (system instruction, user/model roles,
 * functionCall/functionResponse parts, uppercase schema enums) is translated
 * in ./gemini-mapping.ts. The Agent only ever sees normalized events.
 */
export class GeminiProvider implements Provider {
  readonly name = "gemini";
  readonly model: string;
  #client: GoogleGenAI;

  /** `client` is injectable so tests can drive it without network access. */
  constructor(apiKey: string, model: string, client?: GoogleGenAI) {
    this.#client = client ?? new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async *stream(
    messages: ChatMessage[],
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent> {
    const { systemInstruction, contents } = toGeminiRequest(messages);
    const tools = options?.tools ?? [];

    const config: GenerateContentConfig = {};
    if (systemInstruction !== undefined) config.systemInstruction = systemInstruction;
    if (tools.length > 0) {
      config.tools = [{ functionDeclarations: toGeminiTools(tools) }];
    }
    if (options?.signal !== undefined) config.abortSignal = options.signal;

    let chunks;
    try {
      chunks = await this.#client.models.generateContentStream({
        model: this.model,
        contents,
        config,
      });
    } catch (error) {
      yield { type: "error", error };
      return;
    }

    let content = "";
    const calls = new GeminiCallAccumulator();

    try {
      for await (const chunk of chunks) {
        const text = chunk.text;
        if (text !== undefined && text !== "") {
          content += text;
          yield { type: "text-delta", delta: text };
        }
        const functionCalls = chunk.functionCalls;
        if (functionCalls !== undefined && functionCalls.length > 0) {
          calls.add(functionCalls);
        }
      }
    } catch (error) {
      yield { type: "error", error };
      return;
    }

    const message: AssistantMessage = {
      role: "assistant",
      content,
      toolCalls: calls.finish(),
    };
    yield { type: "done", message };
  }
}
