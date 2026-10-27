import { upstreamReleaseFact } from "../src/adapters/upstream.js";
import { stableStringify } from "../src/integrity.js";
import { project, trustedRelease } from "../src/projection.js";
import { popularityCohortMatches } from "../src/schema.js";
import { assertPublishable } from "../src/publish.js";
import { assertInitialCpnReadiness } from "../src/readiness.js";
import { validateWebRankingDataset } from "./schema.js";
import { identityKey, unknown, type Bundle, type Capability, type Fact, type Identity, type ModelFacts, type Popularity, type ReleaseDate } from "../src/types.js";

/** Structural subset of the unchanged models.dev catalog, not a second catalog parser. */
export type CatalogModel = { name: string; release_date?: string; limit?: { context?: number } };
export type CatalogProvider = { name: string; models: Record<string, { canonical_model_id?: string; status?: string; cost?: { input?: number; output?: number } }> };
export type WebRankingModel = {
  id: string;
  name: string;
  lab_id: string;
  href: string;
  providers: string[];
  context: number | null;
  price: { input: number | null; output: number | null };
  release: Fact<ReleaseDate>;
  capability: Fact<Capability>;
  popularity: Fact<Popularity>;
  c: number | null;
  p: number | null;
  n: string | null;
  evidence_refs: { capability: Identity[]; popularity: Identity[] };
};
export type WebRankingDataset = {
  schema_version: 1;
  audience: "local-preview" | "public";
  revision: string;
  published_at: string;
  evaluated_at: string;
  defaults: Bundle["ranking_defaults"] | null;
  profiles: Bundle["metric_profiles"];
  sources: Bundle["source_revisions"];
  attribution: Bundle["attribution"];
  canonical_source: { commit?: string; retrieved_at: string | null; url: string };
  provider_names: Record<string, string>;
  models: WebRankingModel[];
  order: { capability: string[]; popularity: string[]; newest: string[] };
};
export type WebRankingOptions = {
  now: string;
  audience?: WebRankingDataset["audience"];
  canonical_source?: WebRankingDataset["canonical_source"];
  /** Only explicitly canonical-scoped corrections belong here; Provider corrections stay scoped. */
  canonical_release_overrides?: Record<string, Fact<ReleaseDate>>;
  provider_order?: string[];
};

const compare = (a: string | number, b: string | number) => a < b ? -1 : a > b ? 1 : 0;
const minimum = (values: Array<number | undefined>): number | null => {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length ? Math.min(...known) : null;
};

function canonicalId(models: Record<string, CatalogModel>, providerId: string, modelId: string, model: CatalogProvider["models"][string]) {
  if (model.canonical_model_id && Object.hasOwn(models, model.canonical_model_id)) return model.canonical_model_id;
  if (Object.hasOwn(models, modelId)) return modelId;
  const scoped = `${providerId}/${modelId}`;
  if (Object.hasOwn(models, scoped)) return scoped;
}

type Candidate<T> = { identity: Identity; fact: Fact<T> };
function consensus<T>(candidates: Candidate<T>[], usable: (fact: Fact<T>) => boolean, fingerprint: (fact: Fact<T>) => string = fact => fact.state === "known" ? stableStringify({ source_id: fact.source_id, value: fact.value }) : ""): { fact: Fact<T>; identities: Identity[] } {
  // A canonical row reports evidence already attached to explicit member identities.
  // It never writes the selected fact into another Provider's model record.
  const protectedCandidates = candidates.filter(candidate => candidate.fact.state === "withdrawn" || candidate.fact.state === "conflict");
  if (protectedCandidates.length) {
    const first = protectedCandidates[0]!;
    return { fact: structuredClone(first.fact), identities: protectedCandidates.map(candidate => structuredClone(candidate.identity)) };
  }
  const known = candidates.filter(candidate => usable(candidate.fact));
  if (!known.length) return { fact: unknown("No comparable observation associated with a current exact Provider member"), identities: [] };
  const distinct = new Set(known.map(candidate => fingerprint(candidate.fact)));
  if (distinct.size !== 1) return { fact: { state: "conflict", reason: "Associated Provider records disagree within the selected metric; no best-score selection" }, identities: known.map(candidate => structuredClone(candidate.identity)) };
  return { fact: structuredClone(known[0]!.fact), identities: known.map(candidate => structuredClone(candidate.identity)) };
}

/**
 * A read-only visualization projection over a validated Bundle and the original
 * models.dev catalog. Public output uses the same publication and readiness checks
 * as the versioned catalog; local preview retains diagnostic source permissions.
 */
export function buildRankingDataset(bundle: Bundle, models: Record<string, CatalogModel>, providers: Record<string, CatalogProvider>, options: WebRankingOptions): WebRankingDataset {
  if (Number.isNaN(Date.parse(options.now))) throw new Error("Invalid web projection clock");
  const audience = options.audience ?? "local-preview";
  if (audience === "public") {
    assertPublishable(bundle);
    assertInitialCpnReadiness(bundle);
  }
  const upstream = bundle.source_revisions.find(source => source.id === "models-dev");
  const canonicalSource = options.canonical_source ?? { commit: upstream?.code_commit, retrieved_at: upstream?.retrieved_at ?? null, url: upstream?.url ?? "https://github.com/anomalyco/models.dev" };
  const profile = bundle.metric_profiles.find(item => item.id === bundle.ranking_defaults?.capability_profile_id);
  const popularitySource = bundle.source_revisions.find(item => item.id === bundle.ranking_defaults?.popularity_source_id);
  const currentMembers = new Map<string, string>();
  const hosted = new Map<string, Array<{ provider: string; model: CatalogProvider["models"][string] }>>();
  for (const [providerId, provider] of Object.entries(providers)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      // Same membership and price aggregation as packages/web/src/render.tsx.
      if (model.status === "alpha") continue;
      const canonical = canonicalId(models, providerId, modelId, model);
      if (!canonical) continue;
      currentMembers.set(JSON.stringify([providerId, modelId]), canonical);
      const entries = hosted.get(canonical) ?? [];
      entries.push({ provider: providerId, model });
      hosted.set(canonical, entries);
    }
  }
  const byCanonical = new Map<string, ModelFacts[]>();
  for (const fact of bundle.facts) {
    const scope = fact.identity.scope;
    if (!fact.canonical_id || scope.route !== "public" || scope.region !== "global" || scope.plan !== "public") continue;
    if (currentMembers.get(JSON.stringify([fact.identity.provider, fact.identity.request_model_id])) !== fact.canonical_id) continue;
    const group = byCanonical.get(fact.canonical_id) ?? [];
    group.push(fact);
    byCanonical.set(fact.canonical_id, group);
  }
  // Reuse the existing exact matcher/correction pipeline once for the full context.
  // Its public_facts retain observations even when the production sort excludes
  // an unverified redistribution source; this local preview preserves those terms.
  const context = [...byCanonical.values()].flat().map(member => ({ identity: member.identity, display_name: member.display_name }));
  const projected = project(context, bundle, { now: options.now });
  const effective = new Map(projected.capability.map(member => [identityKey(member.identity), member.public_facts]));
  const cUsable = (fact: Fact<Capability>) => !!profile && fact.state === "known" && fact.source_id === profile.source_id && fact.value.profile_id === profile.id && (profile.comparison_policy === "source-headline-v1" || fact.value.model_snapshot === profile.model_snapshot && fact.value.inference_config === profile.inference_config);
  const pUsable = (fact: Fact<Popularity>) => !!popularitySource && fact.state === "known" && fact.source_id === popularitySource.id && fact.value.source_id === popularitySource.id && fact.value.ranking_eligible && popularityCohortMatches(fact.value, popularitySource);
  const rows = Object.entries(models).sort(([a], [b]) => compare(a, b)).map(([id, metadata]): WebRankingModel => {
    const entries = hosted.get(id) ?? [];
    const members = [...(byCanonical.get(id) ?? [])].sort((a, b) => compare(identityKey(a.identity), identityKey(b.identity)));
    const capability = consensus(members.map(member => ({ identity: member.identity, fact: effective.get(identityKey(member.identity))!.capability })), cUsable);
    const popularity = consensus(members.map(member => ({ identity: member.identity, fact: effective.get(identityKey(member.identity))!.popularity })), pUsable, fact => fact.state === "known" ? stableStringify({ source_id: fact.source_id, ranking_eligible: fact.value.ranking_eligible, ...(fact.value.weighted ? { weighted: fact.value.weighted } : { position: fact.value.position }) }) : "");
    const release = options.canonical_release_overrides?.[id] ?? (canonicalSource.retrieved_at ? upstreamReleaseFact(metadata.release_date, undefined, { retrievedAt: canonicalSource.retrieved_at, upstreamEvidence: `${canonicalSource.url}${canonicalSource.commit ? `/blob/${canonicalSource.commit}/models/${id}.toml` : ""}; canonical model release_date resolved by the original models.dev parser` }) : unknown("Canonical catalog source retrieval time is unavailable"));
    return {
      id, name: metadata.name, lab_id: id.split("/")[0]!, href: `/models/${id}/`,
      providers: [...new Set(entries.map(entry => entry.provider))].sort((a, b) => compare(providers[a]!.name, providers[b]!.name) || compare(a, b)),
      context: metadata.limit?.context ?? null,
      price: { input: minimum(entries.map(entry => entry.model.cost?.input)), output: minimum(entries.map(entry => entry.model.cost?.output)) },
      release: structuredClone(release), capability: capability.fact, popularity: popularity.fact,
      c: capability.fact.state === "known" ? capability.fact.value.score : null,
      p: popularity.fact.state === "known" ? popularity.fact.value.weighted?.score ?? null : null,
      n: trustedRelease(release, options.now) ?? null,
      evidence_refs: { capability: capability.identities, popularity: popularity.identities },
    };
  });
  const providerOrder = options.provider_order ?? Object.keys(providers).sort((a, b) => compare(providers[a]!.name, providers[b]!.name) || compare(a, b));
  const providerRank = new Map(providerOrder.map((id, index) => [id, index]));
  const stableRank = new Map(rows.map((row, index) => [row.id, index]));
  const date = (row: WebRankingModel) => row.n ? -Date.parse(row.n) : Number.POSITIVE_INFINITY;
  const cKey = (row: WebRankingModel) => [row.c === null ? 1 : 0, row.c === null ? 0 : row.c * (profile?.direction === "lower" ? 1 : -1)];
  const pKey = (row: WebRankingModel) => row.popularity.state === "known" ? [0, row.popularity.value.weighted ? -row.popularity.value.weighted.score : row.popularity.value.position] : [1, 0];
  const tieKey = (row: WebRankingModel) => [date(row), Math.min(...row.providers.map(id => providerRank.get(id) ?? Number.MAX_SAFE_INTEGER)), stableRank.get(row.id)!, row.id];
  const sorted = (key: (row: WebRankingModel) => (string | number)[]) => rows.map(row => ({ row, key: key(row) })).sort((a, b) => {
    for (let index = 0; index < a.key.length; index++) {
      const delta = compare(a.key[index]!, b.key[index]!);
      if (delta) return delta;
    }
    return 0;
  }).map(item => item.row.id);
  return validateWebRankingDataset({
    schema_version: 1, audience, revision: bundle.revision, published_at: bundle.published_at, evaluated_at: options.now,
    defaults: structuredClone(bundle.ranking_defaults ?? null), profiles: structuredClone(bundle.metric_profiles), sources: structuredClone(bundle.source_revisions), attribution: structuredClone(bundle.attribution), canonical_source: structuredClone(canonicalSource), provider_names: Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, provider.name])), models: rows,
    order: { capability: sorted(row => [...cKey(row), ...tieKey(row)]), popularity: sorted(row => [...pKey(row), ...cKey(row), ...tieKey(row)]), newest: sorted(row => tieKey(row)) },
  });
}
