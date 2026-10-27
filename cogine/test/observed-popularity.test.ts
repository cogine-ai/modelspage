import { describe, expect, test } from "bun:test";
import { observedPopularity, observedPopularityPolicySchema } from "../src/observed-popularity.js";

const policy = observedPopularityPolicySchema.parse({ id: "fixture-observed-v1", weights_status: "proposed", window_days: 3, weights: { router: 0.6, gateway: 0.3, coding: 0.1 } });
const dates = ["2026-10-23", "2026-10-24", "2026-10-25"];

describe("fixed-weight observed popularity union", () => {
  test("any source/day contributes; the denominator remains the entire window", () => {
    const result = observedPopularity(policy, dates, new Map([
      ["router", new Map([[dates[2]!, 40]])],
      ["gateway", new Map([[dates[1]!, 10]])],
    ]));
    expect(result.score).toBeCloseTo(9);
    expect(result.observed_source_weight).toBeCloseTo(0.9);
    expect(result.observed_day_weight).toBeCloseTo(0.3);
    expect(result.evidence.coding!.score).toBeNull();
    expect(result.evidence.router!.daily_shares[dates[0]!]).toBeNull();
    expect(result.evidence.router!.observed_days).toBe(1);
  });
  test("one source is enough; an unavailable source never reallocates its weight", () => {
    const result = observedPopularity(policy, dates, new Map([["coding", new Map([[dates[0]!, 30]])]]));
    expect(result.score).toBe(1);
    expect(result.observed_sources).toBe(1);
    expect(result.evidence.router!.contribution).toBeNull();
    expect(result.evidence.coding!.weight).toBe(0.1);
  });
  test("all missing stays unknown; an explicit source zero is known zero", () => {
    expect(observedPopularity(policy, dates, new Map()).score).toBeNull();
    const zero = observedPopularity(policy, dates, new Map([["router", new Map([[dates[0]!, 0]])]]));
    expect(zero.score).toBe(0);
    expect(zero.evidence.router!.observed_days).toBe(1);
    expect(zero.evidence.gateway!.score).toBeNull();
  });
  test("out-of-window observations do not contribute and shorter windows use the same weights", () => {
    const shares = new Map([["router", new Map([["2026-10-25", 30], ["2026-10-26", 100]])]]);
    expect(observedPopularity(policy, dates, shares).score).toBe(6);
    expect(observedPopularity(policy, ["2026-10-25"], shares).score).toBe(18);
  });
  test("invalid weight vectors and corrupt share denominators cannot produce a score", () => {
    expect(() => observedPopularityPolicySchema.parse({ ...policy, weights: { router: 0.7, gateway: 0.7 } })).toThrow();
    expect(() => observedPopularity(policy, dates, new Map([["router", new Map([[dates[0]!, 101]])]]))).toThrow("finite percentages");
    expect(() => observedPopularity(policy, [], new Map())).toThrow();
  });
});
