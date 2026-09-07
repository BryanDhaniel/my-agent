/**
 * Token usage and cost.
 *
 * Provider usage fields differ per vendor, so they are normalized here into
 * one shape; the Agent never sees vendor-specific fields.
 *
 * Pricing is intentionally NOT invented: the default table is empty, so cost
 * is reported as "unknown" until pricing is registered explicitly. Guessing
 * prices would be worse than reporting nothing.
 */

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

export interface UsageCost {
  inputCost?: number;
  outputCost?: number;
  totalCost?: number;
  currency?: string;
}

export interface ModelPricing {
  /** Cost per one million input tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  currency: string;
}

export class PricingRegistry {
  #byModel = new Map<string, ModelPricing>();

  register(model: string, pricing: ModelPricing): void {
    this.#byModel.set(model, pricing);
  }

  registerAll(entries: Record<string, ModelPricing>): void {
    for (const [model, pricing] of Object.entries(entries)) this.register(model, pricing);
  }

  /** Exact model match first, then longest matching prefix (e.g. "gpt-4o"). */
  find(model: string): ModelPricing | undefined {
    const exact = this.#byModel.get(model);
    if (exact !== undefined) return exact;

    let best: { key: string; pricing: ModelPricing } | undefined;
    for (const [key, pricing] of this.#byModel) {
      if (!model.startsWith(key)) continue;
      if (best === undefined || key.length > best.key.length) best = { key, pricing };
    }
    return best?.pricing;
  }

  get size(): number {
    return this.#byModel.size;
  }
}

/** Empty by default: no invented prices. Register real pricing to get costs. */
export const defaultPricing = new PricingRegistry();

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const input = optionalSum(a.inputTokens, b.inputTokens);
  const output = optionalSum(a.outputTokens, b.outputTokens);
  const cached = optionalSum(a.cachedInputTokens, b.cachedInputTokens);

  const total =
    input !== undefined || output !== undefined
      ? (input ?? 0) + (output ?? 0)
      : a.totalTokens !== undefined || b.totalTokens !== undefined
        ? optionalSum(a.totalTokens, b.totalTokens)
        : undefined;

  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
  };
}

/**
 * Cost for a usage record. Returns `undefined` costs (not zero) when pricing
 * is unknown, so "no data" is never mistaken for "free".
 */
export function estimateCost(usage: TokenUsage, pricing: ModelPricing | undefined): UsageCost {
  if (pricing === undefined) return { currency: "unknown" };

  const inputCost =
    usage.inputTokens !== undefined
      ? (usage.inputTokens / 1_000_000) * pricing.inputPerMTok
      : undefined;
  const outputCost =
    usage.outputTokens !== undefined
      ? (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
      : undefined;

  const totalCost =
    inputCost !== undefined || outputCost !== undefined
      ? (inputCost ?? 0) + (outputCost ?? 0)
      : undefined;

  return {
    ...(inputCost !== undefined ? { inputCost } : {}),
    ...(outputCost !== undefined ? { outputCost } : {}),
    ...(totalCost !== undefined ? { totalCost } : {}),
    currency: pricing.currency,
  };
}

export function formatCost(cost: UsageCost): string {
  if (cost.totalCost === undefined || cost.currency === "unknown") return "unknown";
  return `${cost.totalCost.toFixed(4)} ${cost.currency}`;
}

function optionalSum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}
