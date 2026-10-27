import { expect, test } from "bun:test";
import { applyRankings, rankingDates } from "../src/rankings.js";
import { unknown, PUBLIC_SCOPE, type ModelFacts } from "../src/types.js";
import type { RankSourceEntry, RankSourceSnapshot } from "../src/adapters/rank-sources.js";
import { observedPopularityPolicySchema } from "../src/observed-popularity.js";
import { sha256, stableStringify } from "../src/integrity.js";

const now = "2026-10-26T00:00:00Z", retrieved = "2026-10-25T23:50:00Z", asOf = "2026-10-25T23:30:00Z";
const policy = observedPopularityPolicySchema.parse({ id: "observed-weighted-token-share-v1", weights_status: "accepted", window_days: 7, weights: { openrouter: 0.6, "vercel-ai-gateway": 0.3, "opencode-go-free": 0.1 } });
const dates = rankingDates(now);
const model = (id: string, canonical = `lab/${id}`, protocol = "chat-completions"): ModelFacts => ({ identity: { provider: "provider", request_model_id: id, scope: { ...PUBLIC_SCOPE, protocol } }, display_name: id, canonical_id: canonical, release: { state: "known", value: { date: "2026-01-01", precision: "day", verified: true, version_specific: true }, source_id: "models-dev", retrieved_at: retrieved, data_as_of: null, evidence: "trusted upstream" }, capability: unknown("no C"), popularity: unknown("no P") });
const rows = () => [
  { provider_id: "provider", id: "alpha", canonical_id: "lab/alpha" },
  { provider_id: "provider", id: "beta", canonical_id: "lab/beta" },
  { provider_id: "provider", id: "missing", canonical_id: "lab/missing" },
  { provider_id: "openrouter", id: "lab/alpha", canonical_id: "lab/alpha" },
  { provider_id: "openrouter", id: "lab/beta", canonical_id: "lab/beta" },
  { provider_id: "vercel", id: "lab/alpha", name: "Alpha", canonical_id: "lab/alpha" },
  { provider_id: "vercel", id: "lab/beta", name: "Beta", canonical_id: "lab/beta" },
  { provider_id: "opencode-go", id: "alpha", canonical_id: "lab/alpha" },
  { provider_id: "opencode-go", id: "beta", canonical_id: "lab/beta" },
];
function snapshot(source_id: string, entries: RankSourceEntry[], overrides: Partial<RankSourceSnapshot> = {}): RankSourceSnapshot {
  return { schema_version: 1, source_id, attempted_at: retrieved, retrieved_at: retrieved, data_as_of: asOf, data_as_of_precision: "timestamp", status: "success", complete_response: true, coverage_truncated: false, cutoff: "source returned population", scope: "synthetic test data", window: { start: dates[0]!, end: dates.at(-1)!, label: "complete UTC days" }, usage: { collection: "allowed", redistribution: "allowed", evidence: "Synthetic test data" }, authentication_provided: false, endpoints: [`https://fixtures.invalid/${source_id}`], raw_files: [{ path: "fixture.json", sha256: "a".repeat(64), bytes: 1 }], entries, issues: [], metadata: {}, ...overrides };
}
const aa = (id: string, slug: string, value: number | null, version: number | string = 4.3): RankSourceEntry => ({ source_model_id: id, source_slug: slug, display_name: slug + (slug.endsWith("-high") ? " (High)" : ""), metric: "artificial_analysis_intelligence_index", value, value_unit: "points", index_version: version });
const usage = (id: string, date: string, value: number | string): RankSourceEntry => ({ source_model_id: id, date, metric: "tokens", value, value_unit: "source daily token counts" });

test("C keeps source headline/effort and zero under one comparable index, without changing IDs, membership or N", () => {
  const facts = [model("alpha"), model("beta", "lab/beta", "messages"), model("missing")], before = stableStringify(facts);
  const source = snapshot("artificial-analysis", [aa("aa-alpha", "alpha", 0), aa("aa-high", "alpha-high", 99), aa("aa-beta", "beta", 23)]);
  const result = applyRankings({ facts, registryRows: rows(), snapshots: [source], policy, now });
  expect(result.facts).toHaveLength(facts.length);
  expect(result.facts[0]!.capability).toMatchObject({ state: "known", source_id: "artificial-analysis", retrieved_at: retrieved, data_as_of: asOf, value: { score: 0, model_snapshot: "aa-alpha" } });
  expect(result.facts[1]!.capability).toMatchObject({ state: "known", value: { score: 23, model_snapshot: "aa-beta" } });
  expect(result.facts[2]!.capability.state).toBe("unknown");
  expect(result.profiles[0]).toMatchObject({ method_version: "4.3", comparison_policy: "source-headline-v1" });
  expect(result.defaults.capability_profile_id).toBe(result.profiles[0]!.id);
  for (let i = 0; i < facts.length; i++) {
    expect(result.facts[i]!.identity).toEqual(facts[i]!.identity);
    expect(result.facts[i]!.release).toEqual(facts[i]!.release);
  }
  const fact = result.facts[0]!.capability;
  if (fact.state === "known") {
    expect(fact.value.inference_config).toContain("aa-alpha");
    const evidence = JSON.parse(fact.evidence);
    expect(evidence.snapshot_sha256).toBe(sha256(stableStringify(source)));
    expect(evidence.selected_entry.source_model_id).toBe("aa-alpha");
    expect(evidence.selected_entry).toMatchObject({ metric: "artificial_analysis_intelligence_index", value: 0, index_version: 4.3 });
    expect(evidence.raw_sha256).toEqual(["a".repeat(64)]);
    expect(fact.evidence).not.toContain("fixture.json");
    expect(evidence.alternatives).toHaveLength(2);
  }
  expect(stableStringify(facts)).toBe(before);
});

test("P uses the weighted source/day union and dense composite ties, with missing values distinct from known zero", () => {
  const facts = [model("alpha"), model("beta"), model("missing")];
  const source = snapshot("vercel-ai-gateway", dates.flatMap(date => [usage("Alpha", date, 10), usage("Beta", date, 10)]), { data_as_of: null, data_as_of_precision: null });
  const result = applyRankings({ facts, registryRows: rows(), snapshots: [source], policy, now });
  for (const fact of result.facts.slice(0, 2)) {
    expect(fact.popularity).toMatchObject({ state: "known", data_as_of: null, value: { position: 1, ranking_eligible: true, weighted: { score: 3, sources: { openrouter: { score: null, contribution: null, observed_days: 0 }, "vercel-ai-gateway": { score: 10, observed_days: 7 } } } } });
  }
  expect(result.facts[2]!.popularity.state).toBe("unknown");
  expect(result.sources.find(s => s.id === policy.id)).toMatchObject({ status: "success", complete: true, retrieved_at: retrieved, data_as_of: null, window: { start: dates[0], end: dates.at(-1) } });
  const zero = applyRankings({ facts, registryRows: rows(), snapshots: [snapshot("vercel-ai-gateway", [usage("Alpha", dates[0]!, 0)])], policy, now });
  expect(zero.facts[0]!.popularity).toMatchObject({ state: "known", value: { weighted: { score: 0 } } });
  expect(zero.facts[1]!.popularity.state).toBe("unknown");
});

test("token denominators include Other once and separate native route rows may aggregate to canonical", () => {
  const source = snapshot("openrouter", dates.flatMap(date => [usage("lab/alpha", date, "20"), { ...usage("other", date, "80"), is_aggregate: true }]));
  const result = applyRankings({ facts: [model("alpha")], registryRows: rows(), snapshots: [source], policy, now });
  expect(result.facts[0]!.popularity).toMatchObject({ state: "known", value: { weighted: { score: 12, sources: { openrouter: { score: 20 } } } } });
  const fact = result.facts[0]!.popularity;
  if (fact.state === "known") {
    const pointSource = JSON.parse(fact.evidence).source_entries[0];
    expect(pointSource).toMatchObject({ source_id: "openrouter", snapshot_sha256: sha256(stableStringify(source)) });
    expect(pointSource.points[0]).toMatchObject({ source_model_id: "lab/alpha", date: dates[0], metric: "tokens", value: "20", denominator: 100, share: 20 });
    expect(pointSource.points[0].association_method).toBeTruthy();
  }
  source.entries.push(source.entries[0]!);
  expect(() => applyRankings({ facts: [model("alpha")], registryRows: rows(), snapshots: [source], policy, now })).toThrow("Duplicate source model/day");
});

test("unknown component rights remain unknown while absent sources do not veto known eligible contributions", () => {
  const allowed = snapshot("vercel-ai-gateway", [usage("Alpha", dates.at(-1)!, 70)]);
  const unverified = snapshot("opencode-go-free", [usage("beta", dates.at(-1)!, "100")], { usage: { collection: "diagnostic_only", redistribution: "unverified", evidence: "No explicit redistribution grant" }, metadata: { daily_tokens_totals: [{ date: dates.at(-1), total_tokens: "100" }] } });
  const result = applyRankings({ facts: [model("alpha"), model("beta")], registryRows: rows(), snapshots: [allowed, unverified], policy, now });
  expect(result.facts.map(fact => fact.popularity.state)).toEqual(["known", "known"]);
  expect(result.sources.find(source => source.id === policy.id)!.usage).toMatchObject({ collection: "unverified", redistribution: "unverified" });
  const noObservation = snapshot("opencode-go-free", [], { usage: unverified.usage });
  expect(applyRankings({ facts: [model("alpha")], registryRows: rows(), snapshots: [allowed, noObservation], policy, now }).sources.find(source => source.id === policy.id)!.usage.redistribution).toBe("allowed");
});

test("failed/partial inputs cannot replace known facts; withdrawn/conflict fields and nonpublic scopes are preserved", () => {
  const facts = [model("alpha"), model("beta")];
  facts[0]!.capability = { state: "withdrawn", reason: "withdrawn", correction_id: "correction" };
  facts[0]!.popularity = { state: "conflict", reason: "conflict" };
  facts[1]!.identity.scope.plan = "account-only";
  const source = snapshot("artificial-analysis", [aa("aa-alpha", "alpha", 99), aa("aa-beta", "beta", 99)]);
  const result = applyRankings({ facts, registryRows: rows(), snapshots: [source], policy, now });
  expect(result.facts).toEqual(facts);
  const known = applyRankings({ facts: [model("alpha")], registryRows: rows(), snapshots: [source], policy, now }).facts;
  for (const status of ["failed", "partial"] as const) {
    const unavailable = applyRankings({ facts: known, registryRows: rows(), snapshots: [{ ...source, status, complete_response: false, retrieved_at: null }], policy, now });
    expect(unavailable.facts).toEqual(known);
    expect(unavailable.sources.find(s => s.id === "artificial-analysis")).toMatchObject({ retrieved_at: null, complete: false });
  }
});

test("ambiguous target or source identity and incompatible AA versions cannot create known C", () => {
  const facts = [model("alpha")], source = snapshot("artificial-analysis", [aa("aa-alpha", "alpha", 50), aa("aa-beta", "beta", 70, 5)]);
  const result = applyRankings({ facts, registryRows: rows(), snapshots: [source], policy, now });
  expect(result.facts[0]!.capability.state).toBe("unknown");
  expect(result.profiles).toEqual([]);
  expect(result.issues.some(issue => issue.code === "aa_index_versions_incomparable")).toBe(true);
  const targetConflict = applyRankings({ facts, registryRows: [...rows(), { provider_id: "provider", id: "alpha", canonical_id: "lab/beta" }], snapshots: [snapshot("artificial-analysis", [aa("aa-alpha", "alpha", 50)])], policy, now });
  expect(targetConflict.facts[0]!.capability.state).toBe("unknown");
  expect(targetConflict.issues.some(issue => issue.code === "target_identity_conflict_or_missing")).toBe(true);
});

test("incomplete days and missing denominators stay unknown, and fixed inputs are deterministic", () => {
  expect(rankingDates("2026-10-26T23:59:59Z")).toEqual(dates);
  const source = snapshot("openrouter", [usage("lab/alpha", "2026-10-26", 100), usage("lab/alpha", dates.at(-1)!, 20)]);
  const input = { facts: [model("alpha")], registryRows: rows(), snapshots: [source], policy, now };
  const result = applyRankings(input);
  expect(result.facts[0]!.popularity.state).toBe("unknown");
  expect(result.issues.some(issue => issue.code === "source_daily_denominator_missing")).toBe(true);
  expect(stableStringify(result)).toBe(stableStringify(applyRankings(input)));
});
