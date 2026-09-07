import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { apiKeyEnvVar, isProviderName, type AgentConfig, type ProviderName } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { UnknownProviderError, createProvider } from "./create-provider.js";
import { GeminiProvider } from "./gemini.js";
import { GLMProvider } from "./glm.js";
import { OpenAIProvider } from "./openai.js";

const config = (provider: ProviderName, model = "m"): AgentConfig => ({
  provider,
  model,
  apiKey: "test-key-not-a-real-key",
});

describe("createProvider", () => {
  it("openai -> OpenAIProvider", () => {
    assert.ok(createProvider(config("openai")) instanceof OpenAIProvider);
  });

  it("anthropic -> AnthropicProvider", () => {
    assert.ok(createProvider(config("anthropic")) instanceof AnthropicProvider);
  });

  it("gemini -> GeminiProvider", () => {
    assert.ok(createProvider(config("gemini")) instanceof GeminiProvider);
  });

  it("glm -> GLMProvider", () => {
    assert.ok(createProvider(config("glm")) instanceof GLMProvider);
  });

  it("passes the configured model through untouched", () => {
    assert.equal(createProvider(config("gemini", "gemini-2.5-pro")).model, "gemini-2.5-pro");
    assert.equal(createProvider(config("glm", "glm-4.5-air")).model, "glm-4.5-air");
  });

  it("each provider reports its own name", () => {
    assert.equal(createProvider(config("openai")).name, "openai");
    assert.equal(createProvider(config("anthropic")).name, "anthropic");
    assert.equal(createProvider(config("gemini")).name, "gemini");
    assert.equal(createProvider(config("glm")).name, "glm");
  });

  it("rejects an unknown provider instead of guessing", () => {
    assert.throws(
      () => createProvider(config("llama" as ProviderName)),
      UnknownProviderError,
    );
  });
});

describe("provider configuration", () => {
  it("maps every provider to its API key env var", () => {
    assert.equal(apiKeyEnvVar("openai"), "OPENAI_API_KEY");
    assert.equal(apiKeyEnvVar("anthropic"), "ANTHROPIC_API_KEY");
    assert.equal(apiKeyEnvVar("gemini"), "GEMINI_API_KEY");
    assert.equal(apiKeyEnvVar("glm"), "GLM_API_KEY");
  });

  it("recognises exactly the supported provider names", () => {
    for (const name of ["openai", "anthropic", "gemini", "glm"]) {
      assert.ok(isProviderName(name), `${name} should be supported`);
    }
    assert.ok(!isProviderName("llama"));
    assert.ok(!isProviderName(""));
  });
});
