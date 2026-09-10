import type { Content, FunctionDeclaration } from "@google/genai";
import type { ChatMessage, ToolCallRequest } from "../agent/types.js";
import type { ToolSpec } from "../agent/tool.js";

/**
 * Pure translation between our normalized history and Gemini's shape.
 *
 * Gemini differs from OpenAI/Anthropic in three ways that matter here:
 *  - system text lives in `systemInstruction`, not in the message list
 *  - roles are "user"/"model" (not "assistant")
 *  - a Tool Result is a `functionResponse` part that must carry the *name*
 *    of the call it answers, so we keep an id -> name index as we walk.
 */

export interface GeminiRequest {
  systemInstruction: string | undefined;
  contents: Content[];
}

/** Minimal shape of a streamed Gemini function call. */
export interface GeminiFunctionCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

/**
 * Minimal shape of a streamed Gemini `Part`. A function call and its opaque
 * `thoughtSignature` live on the *same* part, so they must be read together —
 * the SDK's `functionCalls` convenience getter drops the signature.
 */
export interface GeminiCallPart {
  functionCall?: GeminiFunctionCall;
  thoughtSignature?: string;
}

export function toGeminiRequest(messages: ChatMessage[]): GeminiRequest {
  let systemInstruction: string | undefined;
  const contents: Content[] = [];

  /** toolCallId -> tool name, so tool results can name their call. */
  const nameById = new Map<string, string>();

  const push = (role: string, parts: NonNullable<Content["parts"]>): void => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    // Gemini prefers alternating turns; fold adjacent same-role content.
    if (last !== undefined && last.role === role) {
      last.parts = [...(last.parts ?? []), ...parts];
      return;
    }
    contents.push({ role, parts });
  };

  for (const m of messages) {
    switch (m.role) {
      case "system":
        systemInstruction =
          systemInstruction === undefined
            ? m.content
            : `${systemInstruction}\n${m.content}`;
        break;

      case "user":
        push("user", [{ text: m.content }]);
        break;

      case "assistant": {
        const parts: NonNullable<Content["parts"]> = [];
        if (m.content !== "") parts.push({ text: m.content });
        for (const tc of m.toolCalls ?? []) {
          nameById.set(tc.id, tc.name);
          // Echo the provider signature back on the SAME part as the call.
          // Gemini 3 rejects a functionCall part that is missing its
          // thoughtSignature with 400 INVALID_ARGUMENT.
          parts.push({
            functionCall: { name: tc.name, args: parseArgs(tc.arguments) },
            ...(tc.thoughtSignature !== undefined
              ? { thoughtSignature: tc.thoughtSignature }
              : {}),
          });
        }
        push("model", parts);
        break;
      }

      case "tool": {
        const name = nameById.get(m.toolCallId) ?? m.toolCallId;
        push("user", [
          { functionResponse: { name, response: { output: m.content } } },
        ]);
        break;
      }
    }
  }

  return { systemInstruction, contents };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Gemini's schema `type` is an uppercase enum ("OBJECT", "STRING") while our
 * ToolSpec carries plain JSON Schema ("object"). Convert, and drop the
 * JSON-Schema-only keywords Gemini rejects.
 *
 * Gemini consumes an OpenAPI 3.0 subset, not JSON Schema 2020-12. The two
 * incompatible shapes here are `exclusiveMinimum`/`exclusiveMaximum` — zod
 * emits them as numbers (2020-12), but Gemini expects the draft-04 form (a
 * boolean beside `minimum`) and rejects the numeric keyword outright with a
 * 400. We fold the exclusive bound into an inclusive `minimum`/`maximum`,
 * which is the closest Gemini can express.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "additionalProperties",
  "$ref",
  "$defs",
  "$anchor",
  "$id",
  "examples",
]);

export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;

    if (key === "type" && typeof value === "string") {
      out["type"] = value.toUpperCase();
      continue;
    }
    if (key === "exclusiveMinimum" || key === "exclusiveMaximum") {
      // Fold 2020-12 numeric exclusive bounds into inclusive ones so the
      // constraint survives instead of being dropped entirely.
      const inclusive = key === "exclusiveMinimum" ? "minimum" : "maximum";
      if (typeof value === "number" && out[inclusive] === undefined) {
        out[inclusive] = value;
      }
      continue;
    }
    if (key === "properties" && isRecord(value)) {
      out["properties"] = mapValues(value, (v) =>
        isRecord(v) ? toGeminiSchema(v) : v,
      );
      continue;
    }
    if (key === "items" && isRecord(value)) {
      out["items"] = toGeminiSchema(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function toGeminiTools(tools: ToolSpec[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toGeminiSchema(t.parameters) as FunctionDeclaration["parameters"],
  }));
}

/**
 * Assembles streamed function calls. Gemini re-sends the accumulated call at
 * each index, so later chunks simply overwrite earlier ones at that index.
 */
export class GeminiCallAccumulator {
  #calls = new Map<
    number,
    { id: string; name: string; args: string; thoughtSignature?: string }
  >();

  /** Record `functionCalls` (no signature) — used for plain test doubles. */
  add(calls: readonly GeminiFunctionCall[] | undefined): void {
    (calls ?? []).forEach((call, index) => this.#record(index, call, undefined));
  }

  /**
   * Record function-call parts together with their `thoughtSignature`. Parts
   * are indexed by the ordinal of the call among them, so text parts
   * interleaved in the same chunk do not shift the id fallback.
   */
  addParts(parts: readonly GeminiCallPart[] | undefined): void {
    let ordinal = 0;
    for (const part of parts ?? []) {
      const call = part.functionCall;
      if (call === undefined) continue;
      this.#record(ordinal, call, part.thoughtSignature);
      ordinal += 1;
    }
  }

  #record(
    index: number,
    call: GeminiFunctionCall,
    thoughtSignature: string | undefined,
  ): void {
    const prev = this.#calls.get(index);
    const name = call.name ?? prev?.name ?? "";
    const args =
      call.args !== undefined ? JSON.stringify(call.args) : (prev?.args ?? "{}");
    // A later chunk that omits the signature keeps the one we already saw.
    const signature = thoughtSignature ?? prev?.thoughtSignature;
    this.#calls.set(index, {
      id: call.id ?? prev?.id ?? "",
      name,
      args,
      ...(signature !== undefined ? { thoughtSignature: signature } : {}),
    });
  }

  /** Complete Tool Calls in call order; undefined when there were none. */
  finish(): ToolCallRequest[] | undefined {
    if (this.#calls.size === 0) return undefined;
    return [...this.#calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({
        id: c.id === "" ? `${c.name || "call"}-${index}` : c.id,
        name: c.name,
        arguments: c.args,
        ...(c.thoughtSignature !== undefined
          ? { thoughtSignature: c.thoughtSignature }
          : {}),
      }));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mapValues(
  record: Record<string, unknown>,
  fn: (value: unknown) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = fn(value);
  return out;
}
