import { bundleRevision, sha256, stableStringify } from "../src/integrity.js";
import { PUBLIC_SCOPE, unknown, type Bundle, type Capability, type Fact, type Identity, type Manifest, type ModelFacts, type Popularity, type ReleaseDate } from "../src/types.js";

export const timestamp = "2026-10-25T00:00:00.000Z";
export const identity = (request_model_id = "model-v1", provider = "provider-a", scope = PUBLIC_SCOPE): Identity => ({ provider, request_model_id, scope: { ...scope } });
export const known = <T>(value: T, source_id = "fixture"): Fact<T> => ({ state: "known", value, source_id, retrieved_at: timestamp, data_as_of: null, evidence: "Synthetic test evidence, not production data" });
export const release = (date = "2026-10-01", overrides: Partial<ReleaseDate> = {}): Fact<ReleaseDate> => known({ date, precision: "day", verified: true, version_specific: true, ...overrides });
export function model(request_model_id = "model-v1", overrides: Partial<ModelFacts> = {}): ModelFacts {
  return { identity: identity(request_model_id), display_name: "Same display name", release: release(), capability: unknown("No capability evidence"), popularity: unknown("No popularity evidence"), ...overrides };
}
export const capability = (score: number, profile_id = "fixture-profile", inference_config = "reasoning=off"): Fact<Capability> => known({ profile_id, score, model_snapshot: "fixture-snapshot", inference_config });
export const popularity = (position: number, source_model_id = "fixture-entry", ranking_eligible = true): Fact<Popularity> => known({ source_id: "fixture", source_model_id, position, ranking_eligible });
export function bundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    schema_version: 1, revision: "0".repeat(64), builder_version: "1.0.0", publication_sequence: 1, published_at: timestamp,
    source_revisions: [{ id: "fixture", status: "success", retrieved_at: timestamp, data_as_of: null, window: { start: null, end: null }, usage: { collection: "allowed", redistribution: "allowed", evidence: "Synthetic data" }, complete: true }],
    metric_profiles: [{ id: "fixture-profile", source_id: "fixture", name: "Synthetic test profile", metric: "synthetic", method_version: "1", direction: "higher", task: "test only", model_snapshot: "fixture-snapshot", inference_config: "reasoning=off", evaluation_conditions: "No production claims", usage: { collection: "allowed", redistribution: "allowed", evidence: "Synthetic data" } }],
    attribution: [{ source_id: "fixture", license: "CC0-1.0", url: "https://example.invalid", text: "Synthetic tests" }], module_compatibility: { projection: 1, min_consumer_version: "1.0.0" }, facts: [model()], mappings: [], corrections: [], fixture: true, ...overrides,
  };
}
export function seal(input: Bundle = bundle(), manifestSequence?: number) {
  const current = structuredClone(input);
  current.revision = bundleRevision(current);
  const catalog = stableStringify(current);
  const manifest: Manifest = { schema_version: 1, revision: current.revision, publication_sequence: manifestSequence ?? current.publication_sequence, published_at: current.published_at, objects: { catalog: { path: `v1/revisions/${current.revision}/catalog.json`, sha256: sha256(catalog), size: new TextEncoder().encode(catalog).byteLength } }, module_compatibility: current.module_compatibility, fixture: current.fixture };
  return { bundle: current, catalog, manifest };
}
