import { isProviderName, type ProviderName } from "../config.js";
import {
  resolveCredential,
  type CredentialSource,
  type CredentialStore,
  CredentialStoreError,
  CredentialValidationError,
  ProviderNotFoundError,
  ProviderNotConfiguredError,
} from "../credentials/index.js";
import type { ExecutionContext, Observability } from "../observability/index.js";
import { startTimer } from "../observability/index.js";
import { ActiveConfigStore, type ActiveSelection } from "./active-config.js";
import { createProvider as buildProvider } from "./create-provider.js";
import { ModelNotFoundError, ModelProviderMismatchError } from "./errors.js";
import {
  defaultModelFor,
  findModel,
  getProvider,
  isProviderId,
  listProviders as registryProviders,
  resolveModelId,
} from "./registry.js";

/**
 * Provider lifecycle: is it configured, can we build it, which one is active.
 *
 * Three things stay separate here, and conflating them is what makes this
 * kind of feature rot:
 *
 *   credential  — the secret, owned by CredentialStore
 *   provider    — what the provider is and which models it serves (registry)
 *   selection   — what the next run will use (this object)
 *
 * The manager never logs a credential and never hands one to anything except
 * the provider constructor.
 */

export interface ProviderStatus {
  id: ProviderName;
  name: string;
  configured: boolean;
  source: CredentialSource;
  active: boolean;
  activeModelId?: string;
}

/** Injected so setup can validate without the manager knowing any wire format. */
export type CredentialValidator = (input: {
  providerId: ProviderName;
  credential: string;
  modelId: string;
}) => Promise<void>;

export interface ProviderManagerOptions {
  credentials: CredentialStore;
  configStore?: ActiveConfigStore;
  observability?: Observability;
  env?: NodeJS.ProcessEnv;
  /** Skip reading/writing the active-selection file (tests, ephemeral runs). */
  persist?: boolean;
}

export class ProviderManager {
  readonly #credentials: CredentialStore;
  readonly #configStore: ActiveConfigStore;
  readonly #observability: Observability | undefined;
  readonly #context: ExecutionContext | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #persist: boolean;

  #active: ActiveSelection;

  constructor(options: ProviderManagerOptions) {
    this.#credentials = options.credentials;
    this.#configStore = options.configStore ?? new ActiveConfigStore();
    this.#observability = options.observability;
    this.#context =
      options.observability !== undefined
        ? options.observability.newRun("main-agent")
        : undefined;
    this.#env = options.env ?? process.env;
    this.#persist = options.persist ?? true;
    this.#active = { providerId: "openai", modelId: defaultModelFor("openai") ?? "" };
  }

  /** Load the persisted selection. Safe to call more than once. */
  async init(): Promise<void> {
    if (!this.#persist) return;
    const saved = await this.#configStore.load();
    if (saved !== undefined) this.#active = saved;
  }

  getActive(): ActiveSelection {
    return { ...this.#active };
  }

  async listProviders(): Promise<ProviderStatus[]> {
    const active = this.#active;
    const statuses: ProviderStatus[] = [];
    for (const provider of registryProviders()) {
      const { value, source } = await this.#resolve(provider.id);
      statuses.push({
        id: provider.id,
        name: provider.name,
        configured: value !== undefined,
        source,
        active: provider.id === active.providerId,
        ...(provider.id === active.providerId ? { activeModelId: active.modelId } : {}),
      });
    }
    return statuses;
  }

  async isConfigured(providerId: string): Promise<boolean> {
    const { value } = await this.#resolve(providerId);
    return value !== undefined;
  }

  async credentialSource(providerId: string): Promise<CredentialSource> {
    return (await this.#resolve(providerId)).source;
  }

  /**
   * Store a credential. Validation happens first and a rejected key is never
   * written, so a failed setup leaves nothing behind.
   */
  async configure(
    providerId: string,
    credential: string,
    options: { validate?: CredentialValidator } = {},
  ): Promise<void> {
    const provider = this.#requireKnown(providerId);
    const started = startTimer();

    this.#emit("provider.setup.started", { providerId });

    if (credential.trim() === "") {
      const failure = new CredentialValidationError(provider.id, "the API key was empty");
      this.#emit("credential.validation.failed", {
        providerId: provider.id,
        reason: failure.message,
      });
      throw failure;
    }

    const modelId = resolveModelId(provider.id) ?? provider.defaultModel;

    if (options.validate !== undefined) {
      try {
        await options.validate({ providerId: provider.id, credential, modelId });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.#emit("credential.validation.failed", { providerId: provider.id, reason });
        throw new CredentialValidationError(provider.id, reason);
      }
    }

    try {
      await this.#credentials.set(provider.id, credential);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.#emit("credential.store.failed", { providerId: provider.id, reason });
      throw err instanceof CredentialStoreError
        ? err
        : new CredentialStoreError(reason, { cause: err });
    }

    this.#emit("provider.setup.completed", {
      providerId: provider.id,
      modelId,
      durationMs: Math.round(started()),
    });
  }

  /** Persist an environment credential into the store (legacy bootstrap). */
  async importFromEnvironment(providerId: string): Promise<boolean> {
    const provider = this.#requireKnown(providerId);
    const name = provider.credential.environmentVariable;
    if (name === undefined) return false;
    const value = this.#env[name];
    if (typeof value !== "string" || value === "") return false;
    await this.#credentials.set(provider.id, value);
    return true;
  }

  async remove(providerId: string): Promise<void> {
    const provider = this.#requireKnown(providerId);
    await this.#credentials.delete(provider.id);
    this.#emit("provider.removed", { providerId: provider.id });

    // Never keep running on a credential that no longer exists.
    if (this.#active.providerId !== provider.id) return;

    const fallback = (await this.listProviders()).find(
      (p) => p.configured && p.id !== provider.id,
    );
    if (fallback !== undefined) {
      await this.setProvider(fallback.id);
    }
  }

  async setProvider(providerId: string): Promise<void> {
    const provider = this.#requireKnown(providerId);
    if (!(await this.isConfigured(provider.id))) {
      throw new ProviderNotConfiguredError(provider.id);
    }
    await this.#setActive({
      providerId: provider.id,
      modelId: resolveModelId(provider.id) ?? provider.defaultModel,
    });
    this.#emit("provider.selected", {
      providerId: provider.id,
      modelId: this.#active.modelId,
    });
  }

  async setModel(modelId: string): Promise<void> {
    const providerId = this.#active.providerId;
    const model = findModel(providerId, modelId);
    if (model === undefined) {
      if (findModelAcrossProviders(modelId) && !belongsTo(providerId, modelId)) {
        throw new ModelProviderMismatchError(modelId, providerId);
      }
      throw new ModelNotFoundError(modelId);
    }
    await this.#setActive({ providerId, modelId });
    this.#emit("model.selected", { providerId, modelId });
  }

  async setActive(providerId: string, modelId?: string): Promise<void> {
    const provider = this.#requireKnown(providerId);
    const resolved = resolveModelId(provider.id, modelId);
    if (resolved === undefined) throw new ModelNotFoundError(modelId ?? "(none)");
    if (modelId !== undefined && findModel(provider.id, modelId) === undefined) {
      throw new ModelNotFoundError(modelId);
    }
    await this.#setActive({ providerId: provider.id, modelId: resolved });
    this.#emit("model.selected", { providerId: provider.id, modelId: resolved });
  }

  /**
   * Build a Provider for the active selection. Throws rather than returning a
   * half-configured provider when the credential is missing.
   */
  async createProvider(): Promise<Awaited<ReturnType<typeof buildProvider>>> {
    return this.createProviderFor(this.#active.providerId, this.#active.modelId);
  }

  async createProviderFor(
    providerId: string,
    modelId?: string,
  ): Promise<Awaited<ReturnType<typeof buildProvider>>> {
    const provider = this.#requireKnown(providerId);
    const resolvedModel = resolveModelId(provider.id, modelId) ?? provider.defaultModel;
    const { value } = await this.#resolve(provider.id);
    if (value === undefined) {
      throw new ProviderNotConfiguredError(provider.id);
    }
    return buildProvider({ provider: provider.id, model: resolvedModel, apiKey: value });
  }

  async #setActive(next: ActiveSelection): Promise<void> {
    this.#active = next;
    if (!this.#persist) return;
    try {
      await this.#configStore.save(next);
    } catch {
      // A read-only home directory should not break the session: the
      // selection still applies to this process.
    }
  }

  async #resolve(providerId: string): Promise<{ value?: string; source: CredentialSource }> {
    const provider = getProvider(providerId);
    if (provider === undefined) return { source: "none" };
    return resolveCredential({
      store: this.#credentials,
      providerId: provider.id,
      ...(provider.credential.environmentVariable !== undefined
        ? { environmentVariable: provider.credential.environmentVariable }
        : {}),
      env: this.#env,
    });
  }

  #requireKnown(providerId: string) {
    if (!isProviderId(providerId)) throw new ProviderNotFoundError(providerId);
    const provider = getProvider(providerId);
    if (provider === undefined) throw new ProviderNotFoundError(providerId);
    return provider;
  }

  #emit(type: Parameters<Observability["emit"]>[0]["type"], metadata: Record<string, unknown>): void {
    const obs = this.#observability;
    const context = this.#context;
    if (obs === undefined || context === undefined) return;
    // metadata is ids and timings only — no credential ever reaches here.
    obs.emit({ type, context, metadata });
  }
}

function findModelAcrossProviders(modelId: string): boolean {
  return registryProviders().some((p) => p.models.some((m) => m.id === modelId));
}

function belongsTo(providerId: string, modelId: string): boolean {
  return findModel(providerId, modelId) !== undefined;
}
