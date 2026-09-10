import { PricingRegistry, type ModelPricing } from "../observability/usage.js";

export type PricingEntryMap = Record<string, ModelPricing>;

/**
 * Configurable pricing for cost estimation.
 *
 * Cost is intentionally opt-in. By default the registry is empty, so evaluation
 * reports cost as "unknown" instead of guessing. Pass `--pricing default` (or a
 * pricing JSON file) to get an *estimated* cost. Every cost number the runner
 * emits is labelled "estimated" / "unknown" and is never treated as authoritative.
 */

/** Example prices in USD per 1M tokens. OPT-IN ONLY — see buildPricingRegistry. */
export const BUILTIN_PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10, currency: "USD" },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6, currency: "USD" },
  "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8, currency: "USD" },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6, currency: "USD" },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15, currency: "USD" },
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4, currency: "USD" },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5, currency: "USD" },
  "gemini-3.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4, currency: "USD" },
  "gemini-3.8-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5, currency: "USD" },
  "glm-4.6": { inputPerMTok: 0.5, outputPerMTok: 0.5, currency: "USD" },
};

export type PricingSource = "builtin" | PricingEntryMap;

/**
 * Build a pricing registry.
 *
 * - `undefined`  ⇒ empty registry ⇒ all costs "unknown"
 * - `"builtin"`  ⇒ example USD prices (estimated)
 * - `Record`     ⇒ caller-supplied prices (e.g. from a JSON file)
 */
export function buildPricingRegistry(source?: PricingSource): PricingRegistry {
  const registry = new PricingRegistry();
  if (source === undefined) return registry;
  const entries = source === "builtin" ? BUILTIN_PRICING : source;
  registry.registerAll(entries);
  return registry;
}

export function isKnownPricing(registry: PricingRegistry): boolean {
  return registry.size > 0;
}
