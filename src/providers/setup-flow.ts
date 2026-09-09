import { CredentialValidationError, ProviderNotFoundError } from "../credentials/index.js";
import { getProvider, listModels } from "./registry.js";
import type { ModelDefinition, ProviderDefinition } from "./registry.js";
import type { CredentialValidator, ProviderManager } from "./manager.js";

/**
 * The one provider setup flow.
 *
 * Every provider goes through the same steps — check, ask, validate, store,
 * choose a model, activate — with the differences coming from
 * ProviderDefinition rather than from per-provider branches. The UI supplies
 * prompts; it does not implement the flow.
 *
 * Cancellation is real: nothing is persisted until validation passes, so a
 * cancelled setup leaves the previous configuration untouched.
 */

/** The UI half. Every method may resolve `undefined` to mean "cancel". */
export interface SetupPrompts {
  askCredential(provider: ProviderDefinition): Promise<string | undefined>;
  selectModel(
    provider: ProviderDefinition,
    models: readonly ModelDefinition[],
  ): Promise<string | undefined>;
}

export type SetupOutcome =
  | { status: "active"; providerId: string; modelId: string }
  | { status: "cancelled"; providerId: string; stage: "credential" | "model" }
  | { status: "failed"; providerId: string; error: Error };

export interface ProviderSetupFlowOptions {
  providers: ProviderManager;
  /** Injected so setup can validate without hardcoding a wire format. */
  validate?: CredentialValidator;
}

export class ProviderSetupFlow {
  readonly #providers: ProviderManager;
  readonly #validate: CredentialValidator | undefined;

  constructor(options: ProviderSetupFlowOptions) {
    this.#providers = options.providers;
    this.#validate = options.validate;
  }

  async run(
    providerId: string,
    prompts: SetupPrompts,
    options: { forceCredential?: boolean } = {},
  ): Promise<SetupOutcome> {
    const provider = getProvider(providerId);
    if (provider === undefined) {
      throw new ProviderNotFoundError(providerId);
    }

    const configured = await this.#providers.isConfigured(provider.id);

    if (!configured || options.forceCredential === true) {
      const credential = await prompts.askCredential(provider);
      if (credential === undefined) {
        return { status: "cancelled", providerId: provider.id, stage: "credential" };
      }

      try {
        await this.#providers.configure(
          provider.id,
          credential,
          this.#validate !== undefined ? { validate: this.#validate } : {},
        );
      } catch (err) {
        const error =
          err instanceof Error
            ? err
            : new CredentialValidationError(provider.id, String(err));
        // The credential was rejected before it was written, so there is
        // nothing to roll back.
        return { status: "failed", providerId: provider.id, error };
      }
    }

    const models = listModels(provider.id);
    const chosen = await prompts.selectModel(provider, models);
    if (chosen === undefined) {
      // Provider is configured; only the selection step was abandoned.
      return { status: "cancelled", providerId: provider.id, stage: "model" };
    }

    try {
      await this.#providers.setActive(provider.id, chosen);
    } catch (err) {
      return {
        status: "failed",
        providerId: provider.id,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }

    const active = this.#providers.getActive();
    return { status: "active", providerId: active.providerId, modelId: active.modelId };
  }
}
