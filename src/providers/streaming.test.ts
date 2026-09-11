import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { GoogleGenAI } from "@google/genai";
import type OpenAI from "openai";
import { GeminiProvider } from "./gemini.js";
import { GLM_BASE_URL, GLMProvider } from "./glm.js";
import { OpenAIProvider } from "./openai.js";
import { modelSupportsReasoning } from "./registry.js";
import type { StreamEvent } from "./provider.js";

/**
 * Streams driven by injected fake clients: these exercise translation and
 * event shaping without network access or real API keys.
 */

async function collect(source: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function fakeGemini(chunks: unknown[]): GoogleGenAI {
  return {
    models: {
      generateContentStream: async () =>
        (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
    },
  } as unknown as GoogleGenAI;
}

function fakeOpenAI(chunks: unknown[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            for (const chunk of chunks) yield chunk;
          })(),
      },
    },
  } as unknown as OpenAI;
}

describe("GeminiProvider streaming", () => {
  it("turns streamed text into text-delta then done", async () => {
    const provider = new GeminiProvider("k", "gemini-2.5-flash", fakeGemini([{ text: "Hel" }, { text: "lo" }]));
    const events = await collect(provider.stream([{ role: "user", content: "hi" }]));

    assert.deepEqual(events.slice(0, 2), [
      { type: "text-delta", delta: "Hel" },
      { type: "text-delta", delta: "lo" },
    ]);
    const done = events.at(-1);
    assert.ok(done?.type === "done");
    assert.equal(done.message.content, "Hello");
  });

  it("reads text from response parts without logging (regression: chopped TUI)", async () => {
    // A chunk mixing a text part with a functionCall part. Using the SDK's
    // `response.text` getter here logs "there are non-text parts…" to stderr,
    // which lands inside Ink's redraw and corrupts the frame.
    const chunk = {
      candidates: [
        {
          content: {
            parts: [
              { text: "Let me check. " },
              { functionCall: { name: "run_bash", args: { command: "npm test" } } },
              { text: "Running it now." },
            ],
          },
        },
      ],
    };

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    try {
      const provider = new GeminiProvider("k", "gemini-2.5-flash", fakeGemini([chunk]));
      const events = await collect(provider.stream([{ role: "user", content: "hi" }]));
      assert.deepEqual(events.slice(0, 1), [
        { type: "text-delta", delta: "Let me check. Running it now." },
      ]);
    } finally {
      console.warn = original;
    }
    assert.deepEqual(warnings, [], "streaming must not warn to stderr");
  });

  it("normalizes function calls into the common ToolCallRequest shape", async () => {
    const provider = new GeminiProvider(
      "k",
      "gemini-2.5-flash",
      fakeGemini([{ functionCalls: [{ name: "read_file", args: { path: "a.txt" } }] }]),
    );
    const events = await collect(provider.stream([{ role: "user", content: "read it" }]));
    const done = events.at(-1);

    assert.ok(done?.type === "done");
    assert.deepEqual(done.message.toolCalls, [
      { id: "read_file-0", name: "read_file", arguments: '{"path":"a.txt"}' },
    ]);
  });

  it("captures a function call's thoughtSignature from response parts", async () => {
    const chunk = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "run_bash", args: { command: "npm test" } },
                thoughtSignature: "sig-xyz",
              },
            ],
          },
        },
      ],
    };
    const provider = new GeminiProvider("k", "gemini-3.5-flash-lite", fakeGemini([chunk]));
    const events = await collect(provider.stream([{ role: "user", content: "hi" }]));
    const done = events.at(-1);

    assert.ok(done?.type === "done");
    assert.deepEqual(done.message.toolCalls, [
      {
        id: "run_bash-0",
        name: "run_bash",
        arguments: '{"command":"npm test"}',
        thoughtSignature: "sig-xyz",
      },
    ]);
  });

  it("emits an error event and no done when the API fails", async () => {
    const provider = new GeminiProvider("k", "gemini-2.5-flash", {
      models: {
        generateContentStream: async () => {
          throw new Error("quota exceeded");
        },
      },
    } as unknown as GoogleGenAI);

    const events = await collect(provider.stream([{ role: "user", content: "hi" }]));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
  });
});

describe("GLMProvider streaming", () => {
  it("targets the Zhipu OpenAI-compatible endpoint", () => {
    assert.equal(GLM_BASE_URL, "https://open.bigmodel.cn/api/paas/v4");
  });

  it("turns streamed text into text-delta then done", async () => {
    const provider = new GLMProvider(
      "k",
      "glm-4.6",
      undefined,
      fakeOpenAI([{ choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: { content: "lo" } }] }]),
    );
    const events = await collect(provider.stream([{ role: "user", content: "hi" }]));

    assert.deepEqual(events.slice(0, 2), [
      { type: "text-delta", delta: "Hel" },
      { type: "text-delta", delta: "lo" },
    ]);
    const done = events.at(-1);
    assert.ok(done?.type === "done");
    assert.equal(done.message.content, "Hello");
  });

  it("normalizes tool calls into the common ToolCallRequest shape", async () => {
    const provider = new GLMProvider(
      "k",
      "glm-4.6",
      undefined,
      fakeOpenAI([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "read_file", arguments: '{"path":"a.txt"}' },
                  },
                ],
              },
            },
          ],
        },
      ]),
    );
    const events = await collect(provider.stream([{ role: "user", content: "read it" }]));
    const done = events.at(-1);

    assert.ok(done?.type === "done");
    assert.deepEqual(done.message.toolCalls, [
      { id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' },
    ]);
  });

  it("emits an error event when the API fails", async () => {
    const provider = new GLMProvider("k", "glm-4.6", undefined, {
      chat: {
        completions: {
          create: async () => {
            throw new Error("invalid api key");
          },
        },
      },
    } as unknown as OpenAI);

    const events = await collect(provider.stream([{ role: "user", content: "hi" }]));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
  });
});

describe("reasoning effort", () => {
  it("registry flags the Gemini 3 models as reasoning-capable", () => {
    assert.equal(modelSupportsReasoning("gemini", "gemini-3.8-flash"), true);
    assert.equal(modelSupportsReasoning("gemini", "gemini-3.5-flash-lite"), true);
    // Plain chat models must NOT be flagged, or they would 400 on the parameter.
    assert.equal(modelSupportsReasoning("openai", "gpt-4o"), false);
  });

  it("Gemini sends thinkingConfig only for a reasoning model", async () => {
    const captureConfig = async (
      model: string,
    ): Promise<Record<string, unknown> | undefined> => {
      let config: Record<string, unknown> | undefined;
      const client = {
        models: {
          generateContentStream: async (req: { config?: Record<string, unknown> }) => {
            config = req.config;
            return (async function* () {
              yield { text: "ok" };
            })();
          },
        },
      } as unknown as GoogleGenAI;

      const provider = new GeminiProvider("k", model, client);
      provider.setReasoningEffort("high");
      await collect(provider.stream([{ role: "user", content: "hi" }]));
      return config;
    };

    const flagged = await captureConfig("gemini-3.8-flash");
    assert.deepEqual(flagged?.["thinkingConfig"], { thinkingLevel: "HIGH" });

    const plain = await captureConfig("gemini-2.5-flash"); // not in the registry
    assert.equal(plain?.["thinkingConfig"], undefined);
  });

  it("OpenAI omits reasoning_effort for a non-reasoning model", async () => {
    let captured: Record<string, unknown> = {};
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            captured = params;
            return (async function* () {
              yield { choices: [{ delta: { content: "ok" } }] };
            })();
          },
        },
      },
    } as unknown as OpenAI;

    const provider = new OpenAIProvider("k", "gpt-4o", undefined, client);
    provider.setReasoningEffort("high");
    await collect(provider.stream([{ role: "user", content: "hi" }]));

    assert.equal(captured["reasoning_effort"], undefined);
  });
});
