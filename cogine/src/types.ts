// Public JSON contract. Runtime validation lives in schema.ts.
export type Scope = { route: string; region: string; plan: string; protocol: string };
export type Identity = { provider: string; request_model_id: string; scope: Scope };
export type Field = "release" | "capability" | "popularity";
export type Fact<T> =
  | { state: "known"; value: T; source_id: string; retrieved_at: string; data_as_of: string | null; evidence: string }
  | { state: "unknown"; reason: string }
  | { state: "withdrawn"; reason: string; correction_id: string }
  | { state: "conflict"; reason: string };
// verified records source trust; version_specific records applicability to the source
// model record. Neither flag requires an independent local/manual date review.
export type ReleaseDate = { date: string; precision: "day" | "month" | "year"; verified: boolean; version_specific: boolean };
export type Capability = { profile_id: string; score: number; model_snapshot: string; inference_config: string };
export type WeightedPopularity = { method_id: string; score: number; dates: string[]; weights: Record<string, number>; sources: Record<string, { weight: number; score: number | null; contribution: number | null; observed_days: number; missing_days: string[]; daily_shares: Record<string, number | null> }> };
export type Popularity = { source_id: string; source_model_id: string; position: number; ranking_eligible: boolean; weighted?: WeightedPopularity };
export type ModelFacts = { identity: Identity; display_name: string; canonical_id?: string; release: Fact<ReleaseDate>; capability: Fact<Capability>; popularity: Fact<Popularity> };
export type Usage = { collection: "allowed" | "unverified" | "disabled"; redistribution: "allowed" | "unverified" | "disabled"; evidence: string };
export type SourceRevision = { id: string; status: "success" | "not_modified" | "failed" | "partial" | "disabled"; code_commit?: string; url?: string; retrieved_at: string | null; data_as_of: string | null; sha256?: string; window: { start: string | null; end: string | null }; popularity_method?: { id: string; dates: string[]; weights: Record<string, number> }; usage: Usage; complete: boolean; error?: string };
export type MetricProfile = { id: string; source_id: string; name: string; metric: string; method_version: string; direction: "higher" | "lower"; task: string; model_snapshot: string; inference_config: string; evaluation_conditions: string; usage: Usage; comparison_policy?: "source-headline-v1" };
export type Mapping = { id: string; from: Identity; to: Identity; fields: Field[]; canonical_id?: string; evidence: string; reviewed_by: string; reviewed_at: string; status: "approved" | "conflict" | "withdrawn" };
export type Correction = { id: string; identity: Identity; field: Field; action: "replace" | "withdraw" | "conflict"; value?: unknown; reason: string; evidence: string; reviewed_by: string; reviewed_at: string; sequence: number };
export type Bundle = { schema_version: 1 | 2; revision: string; builder_version: string; publication_sequence: number; published_at: string; source_revisions: SourceRevision[]; metric_profiles: MetricProfile[]; attribution: { source_id: string; license: string; url: string; text: string }[]; module_compatibility: { projection: 1 | 2; min_consumer_version: string }; ranking_defaults?: { capability_profile_id: string | null; popularity_source_id: string; policy_id: string }; facts: ModelFacts[]; mappings: Mapping[]; corrections: Correction[]; fixture: boolean };
export type ObjectDescriptor = { path: string; sha256: string; size: number };
export type Manifest = { schema_version: 1; revision: string; publication_sequence: number; published_at: string; objects: { catalog: ObjectDescriptor }; module_compatibility: { projection: 1 | 2; min_consumer_version: string }; fixture: boolean };
export const PUBLIC_SCOPE: Scope = { route: "public", region: "global", plan: "public", protocol: "chat-completions" };
export const unknown = (reason: string): Fact<never> => ({ state: "unknown", reason });
export function identityKey(identity: Identity): string {
  return JSON.stringify([identity.provider, identity.scope.route, identity.scope.region, identity.scope.plan, identity.scope.protocol, identity.request_model_id]);
}
