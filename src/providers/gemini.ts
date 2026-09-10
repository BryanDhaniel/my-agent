import {
  GoogleGenAI,
  type GenerateContentConfig,
  type GenerateContentResponse,
} from "@google/genai";
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
        const text = textOf(chunk);
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

/**
 * Concatenate just the text parts of a streamed chunk.
 *
 * Deliberately does NOT use the SDK's `response.text` getter: when a chunk
 * carries functionCall parts, that getter logs
 * "there are non-text parts functionCall in the response…" to stderr. In a
 * TUI that write lands in the middle of Ink's redraw, which desynchronises
 * its line accounting — the visible symptom is a chopped header and
 * duplicated lines. Reading the parts directly gives the same text with no
 * side effects.
 */
function textOf(chunk: GenerateContentResponse): string {
  const parts = chunk.candidates?.[0]?.content?.parts;
  if (parts !== undefined) {
    let out = "";
    for (const part of parts) {
      if (typeof part.text === "string") out += part.text;
    }
    return out;
  }
  // Plain objects (e.g. test doubles) carry `text` directly. Only read it
  // when the chunk has no candidates: on a real response the `text` getter is
  // the thing that logs the warning, and it only warns when it finds non-text
  // parts — which requires candidates. So this branch is always warning-free.
  const direct = (chunk as { text?: unknown }).text;
  return typeof direct === "string" ? direct : "";
}
