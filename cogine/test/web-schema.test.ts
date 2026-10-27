import { expect, test } from "bun:test";
import { buildRankingDataset, type CatalogModel, type CatalogProvider } from "../web/data.js";
import { publicWebRankingDatasetSchema, validateWebRankingDataset, webRankingsJsonSchema } from "../web/schema.js";
import { stableStringify } from "../src/integrity.js";
import { selectPublishedDataset } from "../web/version.js";
import { unknown, type Bundle, type Popularity } from "../src/types.js";
import { bundle, capability, known, model, timestamp } from "./contract-fixture.js";

const options = { audience: "public" as const, now: timestamp, canonical_source: { commit: "a".repeat(40), retrieved_at: timestamp, url: "https://github.com/anomalyco/models.dev" } };
const ids = ["alpha", "beta", "zero", "unknown"];
const models: Record<string, CatalogModel> = Object.fromEntries(ids.map(id => [`lab/${id}`, { name: id, ...(id !== "unknown" ? { release_date: "2026-10-01" } : {}) }]));
const providers: Record<string, CatalogProvider> = { "provider-a": { name: "A", models: Object.fromEntries(ids.map(id => [id, { canonical_model_id: `lab/${id}`, cost: { input: 2, output: 3 } }])) } };
const weights = { openrouter: 0.6, "vercel-ai-gateway": 0.3, "opencode-go-free": 0.1 };
const dates = ["2026-10-24"];
function popularity(share: number): Popularity {
  return {
    source_id: "fixture", source_model_id: "source-id", position: 1, ranking_eligible: true,
    weighted: { method_id: "fixture", score: share * .6, dates, weights, sources: Object.fromEntries(Object.entries(weights).map(([id, weight]) => [id, { weight, score: id === "openrouter" ? share : null, contribution: id === "openrouter" ? share * weight : null, observed_days: id === "openrouter" ? 1 : 0, missing_days: id === "openrouter" ? [] : dates, daily_shares: { "2026-10-24": id === "openrouter" ? share : null } }])) },
  };
}
function publicInput(): Bundle {
  const input = bundle({
    fixture: false, schema_version: 2, module_compatibility: { projection: 2, min_consumer_version: "2.0.0" },
    ranking_defaults: { capability_profile_id: "fixture-profile", popularity_source_id: "fixture", policy_id: "fixture" },
    facts: [
      model("alpha", { canonical_id: "lab/alpha", capability: capability(60), popularity: known(popularity(7)) }),
      model("beta", { canonical_id: "lab/beta", capability: capability(30), popularity: known(popularity(3.5)) }),
      model("zero", { canonical_id: "lab/zero", capability: capability(0) }),
    ],
  });
  const source = input.source_revisions[0]!;
  source.window = { start: dates[0]!, end: dates[0]! };
  source.popularity_method = { id: "fixture", dates, weights };
  input.source_revisions.push(...["models-dev", ...Object.keys(weights)].map(id => ({ ...structuredClone(source), id, popularity_method: undefined })));
  input.attribution.push({ source_id: "models-dev", license: "MIT", url: "https://github.com/anomalyco/models.dev", text: "Copyright (c) 2025 models.dev" });
  return input;
}

test("public web projection uses publication rights, fixture and initial C/P/N gates", () => {
  const input = publicInput();
  expect(() => buildRankingDataset({ ...input, fixture: true }, models, providers, options)).toThrow("Synthetic");
  input.source_revisions[0]!.usage.redistribution = "unverified";
  expect(() => buildRankingDataset(input, models, providers, options)).toThrow("rights");
  input.source_revisions[0]!.usage.redistribution = "allowed";
  input.metric_profiles[0]!.usage.redistribution = "unverified";
  expect(() => buildRankingDataset(input, models, providers, options)).toThrow("profile");
  input.metric_profiles[0]!.usage.redistribution = "allowed";
  input.facts.forEach(fact => { fact.capability = unknown("Missing C"); });
  expect(() => buildRankingDataset(input, models, providers, options)).toThrow("missing: capability");
  const noP = publicInput();
  noP.facts.forEach(fact => { fact.popularity = unknown("Missing P"); });
  expect(() => buildRankingDataset(noP, models, providers, options)).toThrow("missing: popularity");
  expect(() => buildRankingDataset(publicInput(), {}, providers, options)).toThrow("Public canonical rankings require usable C/P/N");
});

test("public contract preserves ratios, fixed weights, exact source facts, zero and unknown", () => {
  const input = publicInput(), before = stableStringify(input);
  const result = buildRankingDataset(input, models, providers, options);
  expect(result.audience).toBe("public");
  const alpha = result.models[0]!, beta = result.models[1]!;
  expect(alpha.c! / beta.c!).toBe(2);
  expect(alpha.p! / beta.p!).toBe(2);
  expect(alpha.p).toBe(4.2);
  expect(alpha.popularity).toEqual(input.facts[0]!.popularity);
  expect(alpha.popularity.state === "known" && alpha.popularity.value.weighted!.weights).toEqual(weights);
  expect(result.models.find(row => row.id === "lab/zero")).toMatchObject({ c: 0, p: null });
  expect(result.models.find(row => row.id === "lab/unknown")).toMatchObject({ c: null, p: null, n: null });
  expect(result.models.filter(row => row.c !== null)).toHaveLength(3);
  expect(result.models.filter(row => row.p !== null)).toHaveLength(2);
  expect(result.models.filter(row => row.n !== null)).toHaveLength(3);
  expect(result.order.popularity).toEqual(ids.map(id => `lab/${id}`));
  expect(publicWebRankingDatasetSchema.safeParse(result).success).toBe(true);
  expect(stableStringify(input)).toBe(before);
});

test("public web validation rejects malformed facts, invented zeroes and incomplete ranking indexes", () => {
  const result = buildRankingDataset(publicInput(), models, providers, options);
  expect(() => validateWebRankingDataset({ ...result, unknown_field: true })).toThrow();
  const zeroed = structuredClone(result);
  zeroed.models.find(row => row.id === "lab/unknown")!.c = 0;
  expect(() => validateWebRankingDataset(zeroed)).toThrow("C must preserve");
  const malformed = structuredClone(result) as any;
  delete malformed.models[0].capability.evidence;
  expect(() => validateWebRankingDataset(malformed)).toThrow();
  const missing = structuredClone(result);
  missing.order.newest.pop();
  expect(() => validateWebRankingDataset(missing)).toThrow("every model exactly once");
  const duplicate = structuredClone(result);
  duplicate.order.popularity[1] = duplicate.order.popularity[0]!;
  expect(() => validateWebRankingDataset(duplicate)).toThrow("unique");
  const unlicensed = structuredClone(result);
  unlicensed.sources[0]!.usage.redistribution = "unverified";
  expect(() => validateWebRankingDataset(unlicensed)).toThrow("permitted source");
});

test("published JSON schema is generated from the runtime public shape and retains strict required fields", async () => {
  const generated = webRankingsJsonSchema();
  expect(await Bun.file(new URL("../schema/web-rankings.schema.json", import.meta.url)).text()).toBe(stableStringify(generated));
  const definition = generated.definitions!.webRankings as any;
  expect(definition.additionalProperties).toBe(false);
  expect(definition.properties.audience).toMatchObject({ const: "public" });
  expect(definition.required).toEqual(expect.arrayContaining(["schema_version", "audience", "revision", "defaults", "sources", "profiles", "attribution", "models", "order"]));
  expect(definition.properties.models.items.additionalProperties).toBe(false);
  expect(definition.properties.attribution.items.additionalProperties).toBe(false);
  for (const mode of ["capability", "popularity", "newest"]) expect(definition.properties.order.properties[mode].uniqueItems).toBe(true);
});

test("code-only public deployments retain data revision/time; real fact changes advance the dataset", () => {
  const previous = buildRankingDataset(publicInput(), models, providers, options);
  const candidate = { ...structuredClone(previous), revision: "b".repeat(64), published_at: "2026-10-26T10:00:00.000Z", evaluated_at: "2026-10-26T10:00:00.000Z" };
  expect(selectPublishedDataset(candidate, previous)).toBe(previous);
  const changedInput = publicInput();
  changedInput.facts[0]!.capability = capability(61);
  const changed = buildRankingDataset(changedInput, models, providers, options);
  expect(selectPublishedDataset(changed, previous)).toBe(changed);
  expect(previous.models[0]!.c).toBe(60);
});

test("public ranking data and ties are independent of upstream file enumeration order", () => {
  const input = publicInput();
  const first = buildRankingDataset(input, models, providers, options);
  const reordered = buildRankingDataset(input, Object.fromEntries(Object.entries(models).reverse()), Object.fromEntries(Object.entries(providers).reverse()), options);
  expect(stableStringify(reordered)).toBe(stableStringify(first));
});
