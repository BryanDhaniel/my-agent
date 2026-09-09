import type { ProviderManager } from "./manager.js";
import { findModel, getProvider, listModels } from "./registry.js";
import type { ModelDefinition } from "./registry.js";

/**
 * Model selection for the active provider.
 *
 * The TUI talks to this instead of building providers itself, so model
 * knowledge lives in one place and a bad id is rejected before it can reach
 * a request.
 */
export class ModelManager {
  readonly #providers: ProviderManager;

  constructor(providers: ProviderManager) {
    this.#providers = providers;
  }

  getActive(): { providerId: string; modelId: string; model?: ModelDefinition } {
    const { providerId, modelId } = this.#providers.getActive();
    return { providerId, modelId, ...(findModel(providerId, modelId) !== undefined ? { model: findModel(providerId, modelId) } : {}) };
  }

  /** Models for a provider, defaulting to the active one. */
  listModels(providerId?: string): readonly ModelDefinition[] {
    const target = providerId ?? this.#providers.getActive().providerId;
    return listModels(target);
  }

  /** Rows for a picker: each model plus whether it is currently selected. */
  rows(providerId?: string): Array<{ model: ModelDefinition; active: boolean }> {
    const active = this.#providers.getActive();
    return this.listModels(providerId).map((model) => ({
      model,
      active: model.providerId === active.providerId && model.id === active.modelId,
    }));
  }

  async setModel(modelId: string): Promise<void> {
    await this.#providers.setModel(modelId);
  }

  describe(): string {
    const { providerId, modelId } = this.#providers.getActive();
    const provider = getProvider(providerId);
    const name = provider?.name ?? providerId;
    return `${name} · ${modelId}`;
  }
}
