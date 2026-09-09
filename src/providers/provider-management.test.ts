import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  CredentialStoreError,
  CredentialValidationError,
  FileCredentialStore,
  MemoryCredentialStore,
  ProviderNotFoundError,
  ProviderNotConfiguredError,
} from "../credentials/index.js";
import { Observability } from "../observability/index.js";
import { ActiveConfigStore } from "./active-config.js";
import { ModelNotFoundError, ModelProviderMismatchError } from "./errors.js";
import { ProviderManager } from "./manager.js";
import { ModelManager } from "./model-manager.js";
import { ProviderSetupFlow } from "./setup-flow.js";
import { findModel, getProvider, isProviderId, listModels } from "./registry.js";

const SECRET = "sk-test-value-never-logged";

function manager(overrides?: {
  credentials?: MemoryCredentialStore;
  observability?: Observability;
  env?: NodeJS.ProcessEnv;
}): { providers: ProviderManager; credentials: MemoryCredentialStore } {
  const credentials = overrides?.credentials ?? new MemoryCredentialStore();
  const providers = new ProviderManager({
    credentials,
    persist: false,
    ...(overrides?.observability !== undefined
      ? { observability: overrides.observability }
      : {}),
    env: overrides?.env ?? {},
  });
  return { providers, credentials };
}

describe("credential store", () => {
  it("stores, reads, lists and deletes", async () => {
    const store = new MemoryCredentialStore();
    assert.equal(await store.has("openai"), false);
    assert.equal(await store.get("openai"), undefined);

    await store.set("openai", SECRET);
    assert.equal(await store.has("openai"), true);
    assert.equal(await store.get("openai"), SECRET);
    assert.deepEqual(await store.listConfigured(), ["openai"]);

    await store.delete("openai");
    assert.equal(await store.has("openai"), false);
    assert.deepEqual(await store.listConfigured(), []);
  });

  it("refuses an empty credential", async () => {
    const store = new MemoryCredentialStore();
    await assert.rejects(() => store.set("openai", "   "), CredentialStoreError);
    assert.equal(await store.has("openai"), false);
  });

  it("survives a corrupt file without destroying it", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cred-"));
    const file = path.join(dir, "credentials.json");
    fs.writeFileSync(file, "{ not json at all");
    const store = new FileCredentialStore(file);

    // A corrupt file must fail loudly rather than silently reset the user's
    // keys, and it must not be overwritten.
    await assert.rejects(() => store.has("openai"), CredentialStoreError);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json at all");
  });

  it("treats a missing file as empty", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cred-"));
    const store = new FileCredentialStore(path.join(dir, "missing.json"));
    assert.equal(await store.has("openai"), false);
    assert.deepEqual(await store.listConfigured(), []);
  });

  it("writes with owner-only permissions where the platform supports it", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cred-"));
    const file = path.join(dir, "credentials.json");
    const store = new FileCredentialStore(file);
    await store.set("openai", SECRET);

    const mode = await store.permissions();
    if (process.platform !== "win32" && mode !== undefined) {
      assert.equal(mode & 0o077, 0, "group and other must have no access");
    }
    assert.equal(await store.get("openai"), SECRET);
  });

  it("reports storage failure without leaking the value", async () => {
    const store = new MemoryCredentialStore();
    store.failWrites = true;
    await assert.rejects(() => store.set("openai", SECRET), CredentialStoreError);
  });
});

describe("provider registry", () => {
  it("knows its providers", () => {
    assert.equal(isProviderId("openai"), true);
    assert.equal(isProviderId("gemini"), true);
    assert.equal(isProviderId("glm"), true);
    assert.equal(isProviderId("nope"), false);
    assert.equal(getProvider("nope"), undefined);
  });

  it("lists models with the default first", () => {
    const models = listModels("openai");
    assert.ok(models.length > 1);
    assert.equal(models[0]?.id, getProvider("openai")?.defaultModel);
    assert.equal(models[0]?.providerId, "openai");
  });

  it("finds models and rejects cross-provider lookups", () => {
    assert.ok(findModel("openai", "gpt-4o-mini"));
    assert.equal(findModel("openai", "gemini-2.5-flash"), undefined);
    assert.equal(listModels("nope").length, 0);
  });

  it("contains no credentials", () => {
    const dump = JSON.stringify(listModels("openai")) + JSON.stringify(getProvider("glm"));
    assert.equal(dump.includes("sk-"), false);
  });
});

describe("provider manager", () => {
  it("starts unconfigured and reports status without secrets", async () => {
    const { providers } = manager();
    const statuses = await providers.listProviders();
    assert.ok(statuses.length >= 3);
    assert.equal(statuses.every((s) => !s.configured), true);
    assert.equal(JSON.stringify(statuses).includes(SECRET), false);
  });

  it("treats an environment key as configured (legacy bootstrap)", async () => {
    const { providers } = manager({ env: { OPENAI_API_KEY: SECRET } });
    assert.equal(await providers.isConfigured("openai"), true);
    assert.equal(await providers.credentialSource("openai"), "environment");

    const statuses = await providers.listProviders();
    assert.equal(JSON.stringify(statuses).includes(SECRET), false);
  });

  it("prefers the stored credential over the environment", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set("openai", "stored-value");
    const { providers } = manager({ credentials, env: { OPENAI_API_KEY: SECRET } });
    assert.equal(await providers.credentialSource("openai"), "store");
  });

  it("refuses to activate an unconfigured provider", async () => {
    const { providers } = manager();
    await assert.rejects(() => providers.setProvider("openai"), ProviderNotConfiguredError);
  });

  it("rejects unknown providers and models", async () => {
    const { providers } = manager();
    await assert.rejects(() => providers.setProvider("nope"), ProviderNotFoundError);
    // The active default is openai/gpt-4o-mini, so the unknown case has to be
    // an id that no provider serves.
    await assert.rejects(() => providers.setModel("no-such-model"), ModelNotFoundError);
  });

  it("activates a configured provider with its default model", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set("openai", SECRET);
    const { providers } = manager({ credentials });

    await providers.setProvider("openai");
    assert.equal(providers.getActive().providerId, "openai");
    assert.equal(providers.getActive().modelId, getProvider("openai")?.defaultModel);
  });

  it("switches models and rejects one from another provider", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set("openai", SECRET);
    await credentials.set("gemini", "gemini-value");
    const { providers } = manager({ credentials });

    await providers.setProvider("openai");
    await providers.setModel("gpt-4.1");
    assert.equal(providers.getActive().modelId, "gpt-4.1");

    await assert.rejects(
      () => providers.setModel("gemini-2.5-flash"),
      ModelProviderMismatchError,
    );
    assert.equal(providers.getActive().modelId, "gpt-4.1", "unchanged after a bad switch");
  });

  it("validates before storing, so a rejected key is never saved", async () => {
    const { providers, credentials } = manager();
    await assert.rejects(
      () =>
        providers.configure("openai", "bad-key", {
          validate: async () => {
            throw new Error("Invalid API key.");
          },
        }),
      CredentialValidationError,
    );
    assert.equal(await credentials.has("openai"), false);
  });

  it("stores a credential that validates", async () => {
    const { providers, credentials } = manager();
    let seen = "";
    await providers.configure("openai", SECRET, {
      validate: async (input) => {
        seen = input.credential;
      },
    });
    assert.equal(await credentials.has("openai"), true);
    assert.equal(seen, SECRET, "the validator receives the value for the request only");
  });

  it("invalidates the active provider when its credential is removed", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set("openai", SECRET);
    await credentials.set("gemini", "gemini-value");
    const { providers } = manager({ credentials });

    await providers.setProvider("openai");
    await providers.remove("openai");

    assert.equal(await credentials.has("openai"), false);
    assert.notEqual(providers.getActive().providerId, "openai");
    assert.equal(providers.getActive().providerId, "gemini");
  });

  it("imports an environment credential into the store", async () => {
    const { providers, credentials } = manager({ env: { GLM_API_KEY: SECRET } });
    assert.equal(await providers.importFromEnvironment("glm"), true);
    assert.equal(await credentials.get("glm"), SECRET);
    assert.equal(await providers.credentialSource("glm"), "store");
  });

  it("never puts a credential in an observability event", async () => {
    const lines: string[] = [];
    const observability = new Observability({
      level: "debug",
      json: true,
      write: (line) => lines.push(line),
    });
    const { providers } = manager({ observability });

    await providers.configure("openai", SECRET);
    await providers.setProvider("openai");
    await providers.setModel("gpt-4.1");

    const dump = lines.join("\n");
    assert.ok(dump.length > 0, "events should be emitted");
    assert.equal(dump.includes(SECRET), false, "credential must never be logged");
  });

  it("emits lifecycle events", async () => {
    const observability = new Observability({ level: "error" });
    const seen: string[] = [];
    observability.bus.subscribe((event) => seen.push(event.type));

    const { providers } = manager({ observability });
    await providers.configure("openai", SECRET);
    await providers.setProvider("openai");
    await providers.setModel("gpt-4.1");
    await providers.remove("openai");

    assert.ok(seen.includes("provider.setup.completed"));
    assert.ok(seen.includes("provider.selected"));
    assert.ok(seen.includes("model.selected"));
    assert.ok(seen.includes("provider.removed"));
  });

  it("persists the selection without the credential", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cfg-"));
    const configStore = new ActiveConfigStore(path.join(dir, "config.json"));
    const credentials = new MemoryCredentialStore();
    await credentials.set("gemini", SECRET);
    const providers = new ProviderManager({ credentials, configStore });

    await providers.setProvider("gemini");
    await providers.setModel("gemini-2.5-pro");

    const raw = fs.readFileSync(path.join(dir, "config.json"), "utf8");
    assert.equal(raw.includes(SECRET), false);
    const parsed = JSON.parse(raw) as { provider: string; model: string };
    assert.equal(parsed.provider, "gemini");
    assert.equal(parsed.model, "gemini-2.5-pro");

    const restored = new ProviderManager({ credentials, configStore });
    await restored.init();
    assert.deepEqual(restored.getActive(), { providerId: "gemini", modelId: "gemini-2.5-pro" });
  });

  it("ignores a corrupt selection file and falls back to defaults", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cfg-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "{ broken");
    const configStore = new ActiveConfigStore(file);
    assert.equal(await configStore.load(), undefined);
  });
});

describe("model manager", () => {
  it("lists models for the active provider and marks the selection", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set("openai", SECRET);
    const { providers } = manager({ credentials });
    await providers.setProvider("openai");

    const models = new ModelManager(providers);
    const rows = models.rows();
    assert.ok(rows.length > 1);
    assert.equal(rows.filter((r) => r.active).length, 1);

    await models.setModel("gpt-4o");
    assert.equal(models.getActive().modelId, "gpt-4o");
    assert.match(models.describe(), /OpenAI/);
    assert.equal(models.describe().includes(SECRET), false);
  });
});

describe("provider setup flow", () => {
  const prompts = (overrides?: {
    credential?: string | undefined;
    model?: string | undefined;
  }): ConstructorParameters<typeof ProviderSetupFlow>[0] extends never
    ? never
    : {
        askCredential: () => Promise<string | undefined>;
        selectModel: () => Promise<string | undefined>;
      } => ({
    askCredential: async () => ("credential" in (overrides ?? {}) ? overrides?.credential : SECRET),
    selectModel: async () => ("model" in (overrides ?? {}) ? overrides?.model : "gpt-4.1"),
  });

  it("runs the whole first-time flow", async () => {
    const { providers, credentials } = manager();
    const flow = new ProviderSetupFlow({ providers });

    const outcome = await flow.run("openai", prompts());
    assert.equal(outcome.status, "active");
    assert.equal(await credentials.has("openai"), true);
    assert.equal(providers.getActive().modelId, "gpt-4.1");
  });

  it("skips the credential prompt when already configured", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set("openai", SECRET);
    const { providers } = manager({ credentials });
    let asked = 0;
    const flow = new ProviderSetupFlow({ providers });

    const outcome = await flow.run("openai", {
      askCredential: async () => {
        asked++;
        return SECRET;
      },
      selectModel: async () => "gpt-4o",
    });

    assert.equal(outcome.status, "active");
    assert.equal(asked, 0, "must not re-ask for a key that already works");
  });

  it("cancels cleanly at the credential step", async () => {
    const { providers, credentials } = manager();
    const flow = new ProviderSetupFlow({ providers });

    const outcome = await flow.run("openai", prompts({ credential: undefined }));
    assert.equal(outcome.status, "cancelled");
    assert.equal(await credentials.has("openai"), false);
    assert.equal(providers.getActive().providerId, "openai");
  });

  it("keeps the provider configured when only model selection is cancelled", async () => {
    const { providers, credentials } = manager();
    const flow = new ProviderSetupFlow({ providers });

    const outcome = await flow.run("openai", prompts({ model: undefined }));
    assert.equal(outcome.status, "cancelled");
    assert.equal(await credentials.has("openai"), true, "the key was valid and stays");
  });

  it("reports a validation failure and stores nothing", async () => {
    const { providers, credentials } = manager();
    const flow = new ProviderSetupFlow({
      providers,
      validate: async () => {
        throw new Error("Invalid API key.");
      },
    });

    const outcome = await flow.run("openai", prompts());
    assert.equal(outcome.status, "failed");
    assert.equal(await credentials.has("openai"), false);
  });

  it("reports a storage failure without activating", async () => {
    const credentials = new MemoryCredentialStore();
    credentials.failWrites = true;
    const { providers } = manager({ credentials });
    const flow = new ProviderSetupFlow({ providers });

    const outcome = await flow.run("openai", prompts());
    assert.equal(outcome.status, "failed");
  });

  it("rejects an unknown provider", async () => {
    const { providers } = manager();
    const flow = new ProviderSetupFlow({ providers });
    await assert.rejects(() => flow.run("nope", prompts()), ProviderNotFoundError);
  });
});
