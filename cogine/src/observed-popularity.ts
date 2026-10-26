import { z } from "zod";

export const observedPopularityPolicySchema = z.object({
  id: z.string().min(1),
  weights_status: z.enum(["proposed", "accepted"]),
  window_days: z.number().int().min(1).max(366),
  weights: z.record(z.number().finite().min(0).max(1)),
}).strict().superRefine((policy, context) => {
  const weights = Object.values(policy.weights);
  if (!weights.length || Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) > 1e-9) context.addIssue({ code: z.ZodIssueCode.custom, message: "Global popularity weights must sum to one" });
});
export type ObservedPopularityPolicy = z.infer<typeof observedPopularityPolicySchema>;
export type DailyShares = ReadonlyMap<string, ReadonlyMap<string, number>>;

// This is the weighted contribution of observed evidence. Missing rows remain
// unknown: the result is not an estimate of their unreported platform usage.
export function observedPopularity(policy: ObservedPopularityPolicy, dates: string[], shares: DailyShares) {
  if (!dates.length || new Set(dates).size !== dates.length) throw new Error("A unique nonempty popularity window is required");
  const evidence = Object.fromEntries(Object.entries(policy.weights).map(([source, weight]) => {
    const values = shares.get(source);
    const daily = Object.fromEntries(dates.map(date => [date, values?.get(date) ?? null]));
    const observed = Object.values(daily).filter((value): value is number => value !== null);
    if (observed.some(value => !Number.isFinite(value) || value < 0 || value > 100)) throw new Error("Daily platform token shares must be finite percentages");
    const score = observed.length ? observed.reduce((sum, value) => sum + value, 0) / dates.length : null;
    return [source, { weight, score, contribution: score === null ? null : weight * score, observed_days: observed.length, missing_days: dates.filter(date => daily[date] === null), daily_shares: daily }];
  }));
  const present = Object.values(evidence).filter(item => item.weight > 0 && item.contribution !== null);
  return {
    score: present.length ? present.reduce((sum, item) => sum + item.contribution!, 0) : null,
    evidence,
    observed_sources: present.length,
    observed_source_weight: present.reduce((sum, item) => sum + item.weight, 0),
    observed_day_weight: present.reduce((sum, item) => sum + item.weight * item.observed_days / dates.length, 0),
  };
}
