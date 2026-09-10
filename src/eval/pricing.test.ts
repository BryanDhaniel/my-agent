import { describe, it, expect } from "vitest";
import { buildPricingRegistry, isKnownPricing, BUILTIN_PRICING } from "./pricing.js";
import { estimateCost, formatCost } from "../observability/usage.js";
import type { TokenUsage } from "../observability/usage.js";

describe("pricing", () => {
  it("returns an empty registry by default so cost stays unknown", () => {
    const reg = buildPricingRegistry();
    expect(reg.size).toBe(0);
    expect(isKnownPricing(reg)).toBe(false);
    const cost = estimateCost({ inputTokens: 1000, outputTokens: 500 } as TokenUsage, reg.find("gpt-4o"));
    expect(cost.currency).toBe("unknown");
    expect(formatCost(cost)).toBe("unknown");
  });

  it("builds from the builtin table and computes estimated cost", () => {
    const reg = buildPricingRegistry("builtin");
    expect(isKnownPricing(reg)).toBe(true);
    const price = reg.find("gpt-4o")!;
    expect(price.currency).toBe("USD");
    const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, price);
    // 2.5 + 10 = 12.5 USD for 1M/1M
    expect(cost.totalCost).toBeCloseTo(12.5);
  });

  it("supports a caller-supplied price map", () => {
    const reg = buildPricingRegistry({ "my-model": { inputPerMTok: 1, outputPerMTok: 2, currency: "USD" } });
    expect(reg.find("my-model")?.outputPerMTok).toBe(2);
  });

  it("exposes known model ids in the builtin table", () => {
    expect(Object.keys(BUILTIN_PRICING).length).toBeGreaterThan(0);
  });
});
