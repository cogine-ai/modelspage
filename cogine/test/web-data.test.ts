import { expect, test } from "bun:test";
import { buildRankingDataset, type CatalogModel, type CatalogProvider } from "../web/data.js";
import { bundle, capability, identity, known, model, popularity, release, timestamp } from "./contract-fixture.js";
import { unknown, type Bundle, type ModelFacts, type Popularity } from "../src/types.js";
import { stableStringify } from "../src/integrity.js";

const options = { now: timestamp, canonical_source: { commit: "a".repeat(40), retrieved_at: timestamp, url: "https://github.com/anomalyco/models.dev" } };
function input(facts: ModelFacts[] = []): Bundle {
  return bundle({ facts, ranking_defaults: { capability_profile_id: "fixture-profile", popularity_source_id: "fixture", policy_id: "fixture" } });
}
function metadata(ids: string[]): Record<string, CatalogModel> {
  return Object.fromEntries(ids.map(id => [`lab/${id}`, { name: id, release_date: "2026-10-01", limit: { context: 1000 } }]));
}
function providers(ids: string[]): Record<string, CatalogProvider> {
  return { "provider-a": { name: "A", models: Object.fromEntries(ids.map(id => [id, { canonical_model_id: `lab/${id}`, cost: { input: 2, output: 3 } }])) } };
}
function canonical(id: string, overrides: Partial<ModelFacts> = {}): ModelFacts {
  return model(id, { canonical_id: `lab/${id}`, ...overrides });
}

test("web keeps canonical membership and original minimum-price semantics without inheriting facts into providers", () => {
  const models = metadata(["alpha", "unknown"]), hosted = providers(["alpha", "unknown"]);
  hosted["provider-b"] = { name: "B", models: { second: { canonical_model_id: "lab/alpha", cost: { input: 0, output: 8 } }, exclusive: { cost: { input: 0, output: 0 } }, preview: { canonical_model_id: "lab/alpha", status: "alpha", cost: { input: 0, output: 0 } } } };
  const facts = [canonical("alpha", { capability: capability(0) }), model("second", { identity: identity("second", "provider-b"), canonical_id: "lab/alpha" }), model("unavailable", { canonical_id: "lab/not-in-original-catalog", capability: capability(999) })];
  const data = input(facts), before = stableStringify({ data, models, hosted });
  const result = buildRankingDataset(data, models, hosted, options);
  expect(result.models.map(row => row.id)).toEqual(["lab/alpha", "lab/unknown"]);
  expect(result.models[0]).toMatchObject({ c: 0, p: null, price: { input: 0, output: 3 }, providers: ["provider-a", "provider-b"], context: 1000 });
  expect(result.models[1]).toMatchObject({ c: null, p: null, capability: { state: "unknown" } });
  expect(result.models[0]!.evidence_refs.capability).toEqual([facts[0]!.identity]);
  expect(stableStringify({ data, models, hosted })).toBe(before);
});

test("web capability consensus ignores citation wording while preserving real score/config conflicts", () => {
  const hosted = providers(["alpha"]);
  hosted["provider-b"] = { name: "B", models: { alias: { canonical_model_id: "lab/alpha" } } };
  const a = canonical("alpha", { capability: capability(30) });
  const b = canonical("alpha", { identity: identity("alias", "provider-b"), capability: { ...capability(30), evidence: "Another scoped source citation" } as ModelFacts["capability"] });
  const data = input([a, b]);
  let result = buildRankingDataset(data, metadata(["alpha"]), hosted, options);
  expect(result.models[0]!.c).toBe(30);
  expect(result.models[0]!.evidence_refs.capability).toHaveLength(2);
  b.capability = capability(31);
  result = buildRankingDataset(data, metadata(["alpha"]), hosted, options);
  expect(result.models[0]).toMatchObject({ c: null, capability: { state: "conflict" } });
  b.capability = capability(999, "other-profile");
  expect(buildRankingDataset(data, metadata(["alpha"]), hosted, options).models[0]!.c).toBe(30);
  a.capability = capability(999, "fixture-profile", "reasoning=high");
  expect(buildRankingDataset(data, metadata(["alpha"]), hosted, options).models[0]!.c).toBeNull();
});

test("local preview retains real weighted union observations and source usage without producing a publication bundle", () => {
  const fact: Popularity = { source_id: "fixture", source_model_id: "lab/alpha", ranking_eligible: true, position: 1, weighted: { method_id: "fixture", score: 4.2, dates: ["2026-10-24"], weights: { openrouter: 0.6, "vercel-ai-gateway": 0.3, "opencode-go-free": 0.1 }, sources: { openrouter: { weight: 0.6, score: 7, contribution: 4.2, observed_days: 1, missing_days: [], daily_shares: { "2026-10-24": 7 } }, "vercel-ai-gateway": { weight: 0.3, score: null, contribution: null, observed_days: 0, missing_days: ["2026-10-24"], daily_shares: { "2026-10-24": null } }, "opencode-go-free": { weight: 0.1, score: null, contribution: null, observed_days: 0, missing_days: ["2026-10-24"], daily_shares: { "2026-10-24": null } } } } };
  const data = input([canonical("alpha", { capability: capability(30), popularity: known(fact) })]);
  data.source_revisions[0]!.usage.redistribution = "unverified";
  data.source_revisions[0]!.window = { start: "2026-10-24", end: "2026-10-24" };
  data.source_revisions[0]!.popularity_method = { id: "fixture", dates: fact.weighted!.dates, weights: fact.weighted!.weights };
  data.metric_profiles[0]!.usage.redistribution = "unverified";
  const hosted = providers(["alpha"]);
  hosted["provider-b"] = { name: "B", models: { alias: { canonical_model_id: "lab/alpha" } } };
  data.facts.push(canonical("alpha", { identity: identity("alias", "provider-b"), popularity: known({ ...fact, source_model_id: "another-provider-reference" }) }));
  const result = buildRankingDataset(data, metadata(["alpha"]), hosted, options);
  expect(result.audience).toBe("local-preview");
  expect(result.models[0]).toMatchObject({ p: 4.2, c: 30 });
  expect(result.models[0]!.popularity).toEqual(data.facts[0]!.popularity);
  expect(result.models[0]!.evidence_refs.popularity).toHaveLength(2);
  expect(result.sources[0]!.usage.redistribution).toBe("unverified");
  data.source_revisions[0]!.popularity_method!.dates = ["2026-10-23"];
  expect(buildRankingDataset(data, metadata(["alpha"]), hosted, options).models[0]!.p).toBeNull();
});

test("exact identity, canonical association and reviewed conflicts defeat display-name or route guesses", () => {
  const data = input([
    canonical("Alpha", { capability: capability(1000) }),
    canonical("alpha", { identity: identity("alpha", "other-provider"), capability: capability(1000) }),
    canonical("alpha", { identity: identity("alpha", "provider-a", { route: "public", region: "eu", plan: "public", protocol: "chat-completions" }), capability: capability(1000) }),
    canonical("alpha", { capability: capability(30) }),
  ]);
  data.mappings.push({ id: "conflict", from: identity("alpha"), to: identity("alpha"), fields: ["capability"], canonical_id: "lab/alpha", evidence: "Reviewed conflict", reviewed_by: "test", reviewed_at: timestamp, status: "conflict" });
  expect(buildRankingDataset(data, metadata(["alpha"]), providers(["alpha"]), options).models[0]).toMatchObject({ c: null, capability: { state: "conflict" } });
  data.mappings = [];
  data.facts[3]!.canonical_id = "lab/other";
  expect(buildRankingDataset(data, metadata(["alpha"]), providers(["alpha"]), options).models[0]!.c).toBeNull();
});

test("canonical N trusts models.dev precision, ignores legitimate Provider date differences and accepts scoped overrides", () => {
  const models = metadata(["day", "month", "future", "invalid"]);
  models["lab/month"]!.release_date = "2026-10";
  models["lab/future"]!.release_date = "2027-01-01";
  models["lab/invalid"]!.release_date = "2026-02-30";
  const data = input([canonical("day", { release: release("2020-01-01") })]);
  const result = buildRankingDataset(data, models, providers(["day", "month", "future", "invalid"]), options);
  expect(result.models.find(row => row.id === "lab/day")).toMatchObject({ n: "2026-10-01", release: { state: "known", source_id: "models-dev" } });
  expect(result.models.find(row => row.id === "lab/month")).toMatchObject({ n: null, release: { state: "known", value: { date: "2026-10", precision: "month" } } });
  expect(result.models.find(row => row.id === "lab/future")).toMatchObject({ n: null, release: { state: "known", value: { date: "2027-01-01", precision: "day" } } });
  expect(result.models.find(row => row.id === "lab/invalid")).toMatchObject({ n: null, release: { state: "unknown" } });
  const revised = buildRankingDataset(data, models, providers(["day"]), { ...options, canonical_release_overrides: { "lab/day": { state: "withdrawn", correction_id: "canonical-date", reason: "Canonical date withdrawn" } } });
  expect(revised.models[0]).toMatchObject({ n: null, release: { state: "withdrawn" } });
});

test("full canonical order uses P then C then N before filtering and never turns fallback into a metric", () => {
  const ids = ["none", "n", "c", "p", "zero"], models = metadata(ids);
  models["lab/none"]!.release_date = undefined;
  models["lab/n"]!.release_date = "2026-10-24";
  const data = input([canonical("p", { popularity: popularity(1) }), canonical("c", { capability: capability(50) }), canonical("zero", { capability: capability(0) })]);
  const result = buildRankingDataset(data, models, providers(ids), options);
  expect(result.order.popularity).toEqual(["lab/p", "lab/c", "lab/zero", "lab/n", "lab/none"]);
  expect(result.order.capability).toEqual(["lab/c", "lab/zero", "lab/n", "lab/p", "lab/none"]);
  expect(result.order.popularity.filter(id => id === "lab/n" || id === "lab/c")).toEqual(["lab/c", "lab/n"]);
  expect(result.models.find(row => row.id === "lab/c")!.p).toBeNull();
  expect(stableStringify(result)).toBe(stableStringify(buildRankingDataset(data, models, providers(ids), options)));
});
