import path from "node:path";
import { atomicWrite, bundleRevision, sha256, stableStringify } from "./integrity.js";
import { applyCorrections } from "./corrections.js";
import { popularityCohortMatches, validateBundle, validateManifest } from "./schema.js";
import { identityKey, unknown, type Bundle, type Correction, type Manifest, type Mapping, type ModelFacts, type SourceRevision } from "./types.js";
import { loadFixtureUpstream, loadUpstream, type ReleaseVerification } from "./adapters/upstream.js";
import { OpenRouterConfig, validateOpenRouterSnapshot, type PopularityEntry } from "./adapters/openrouter.js";
import { coverageMarkdown, coverageReport, type CoverageReport } from "./coverage.js";
import { openRankingInput } from "./ranking-input.js";
import { reviewedRankUsage } from "./ranking-collect.js";
import { applyRankings } from "./rankings.js";
import { observedPopularityPolicySchema } from "./observed-popularity.js";
import type { RankSourceSnapshot } from "./adapters/rank-sources.js";

export type BuildOptions = { fixture?: boolean; publishedAt: string; sequence: number; outDir: string; previousBundlePath?: string; openrouterSnapshotPath?: string; rankingsInputPath?: string; root?: string };
async function jsonOr<T>(file: string, fallback: T): Promise<T> { return await Bun.file(file).exists() ? await Bun.file(file).json() as T : fallback; }

export function mergeCorrections(previous: Correction[], current: Correction[]): Correction[] {
  const merged = new Map<string, Correction>();
  for (const correction of [...previous, ...current]) {
    const old = merged.get(correction.id);
    if (old && stableStringify(old) !== stableStringify(correction)) throw new Error(`Immutable correction ${correction.id} changed; add a new revision instead`);
    merged.set(correction.id, correction);
  }
  return [...merged.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id, "en"));
}

export function sparsePublicFacts(facts: ModelFacts[], mappings: Mapping[], corrections: Correction[], publishedAt: string): ModelFacts[] {
  const auditKeys = new Set([...mappings.flatMap((mapping) => [identityKey(mapping.from), identityKey(mapping.to)]), ...corrections.map((correction) => identityKey(correction.identity))]);
  return facts.filter((fact) => {
    const release = fact.release;
    const validN = release.state === "known" && release.value.verified && release.value.version_specific && release.value.precision === "day" && release.value.date <= publishedAt.slice(0, 10);
    // Keep every explicitly supplied C/P fact: publication must still enforce its rights/completeness.
    // A sparse projection must never hide an unapproved metric to bypass the publisher gate.
    return validN || fact.capability.state === "known" || fact.popularity.state === "known" || auditKeys.has(identityKey(fact.identity));
  }).map((fact) => {
    const result = structuredClone(fact);
    if (result.release.state === "known" && (!result.release.value.verified || !result.release.value.version_specific || result.release.value.date > publishedAt.slice(0, 10))) result.release = unknown("No trusted, already public release date applicable to this source model record");
    return result;
  });
}

export async function build(options: BuildOptions): Promise<{ bundle: Bundle; manifest: Manifest; coverage: CoverageReport }> {
  const root = options.root ?? process.cwd();
  if (!Number.isSafeInteger(options.sequence) || options.sequence < 1 || !/^\d{4}-\d{2}-\d{2}T/.test(options.publishedAt) || !Number.isFinite(Date.parse(options.publishedAt))) throw new Error("Build requires an explicit valid publishedAt clock and positive safe publication sequence");
  const previous = options.previousBundlePath ? validateBundle(await Bun.file(options.previousBundlePath).json()) : undefined;
  if (previous && previous.fixture !== !!options.fixture) throw new Error("Cannot mix fixture and production lineage");
  const configDir = path.join(root, options.fixture ? "cogine/fixtures" : "cogine/config");
  const verifications = await jsonOr<ReleaseVerification[]>(path.join(configDir, "release-verifications.json"), []);
  const upstream = options.fixture ? await loadFixtureUpstream(root) : await loadUpstream(root, verifications);
  const rankingsPath = options.rankingsInputPath ?? path.join(root, options.fixture ? "cogine/fixtures/rankings.json" : "cogine/data/rankings.json");
  const rankingInput = await Bun.file(rankingsPath).exists() ? openRankingInput(await Bun.file(rankingsPath).json()) : undefined;
  if (options.rankingsInputPath && !rankingInput) throw new Error("The explicitly selected reviewed ranking input is missing");
  if (rankingInput && rankingInput.evaluation_date > options.publishedAt.slice(0, 10)) throw new Error("Ranking input evaluation date is later than the fixed build clock");
  const mappings = await jsonOr<Mapping[]>(path.join(configDir, "mappings.json"), []);
  const corrections = mergeCorrections(previous?.corrections ?? [], await jsonOr<Correction[]>(path.join(configDir, "corrections.json"), []));
  const facts = new Map(upstream.facts.map((fact) => [identityKey(fact.identity), fact]));
  // Public absence never means account unavailability or retirement. Retain historical facts.
  for (const fact of previous?.facts ?? []) {
    const current = facts.get(identityKey(fact.identity));
    if (!current) facts.set(identityKey(fact.identity), structuredClone(fact));
    // No active capability adapter means no new evidence or retraction. Preserve last-good C.
    else current.capability = structuredClone(fact.capability);
  }
  const openrouterPath = options.openrouterSnapshotPath ?? path.join(root, options.fixture ? "cogine/fixtures/openrouter-snapshot.json" : "cogine/data/openrouter.json");
  const snapshotInput = rankingInput ? undefined : await jsonOr<unknown>(openrouterPath, undefined);
  const snapshot = snapshotInput === undefined ? undefined : validateOpenRouterSnapshot(snapshotInput);
  const configuration = OpenRouterConfig.parse(await Bun.file(path.join(root, options.fixture ? "cogine/fixtures/openrouter-config.json" : "cogine/config/openrouter.json")).json());
  // Source bytes may remain valid across a failed collection attempt; publishing authority
  // comes from the current reviewed configuration, never a frozen snapshot/catalog grant.
  const previousSource = previous?.source_revisions.find((source) => source.id === "openrouter-weekly");
  const previousOpenrouter = previousSource ? { ...previousSource, usage: configuration.usage } : undefined;
  let openrouterSource: SourceRevision;
  let currentOpenrouterEntries: Map<string, PopularityEntry> | undefined;
  if (snapshot) {
    openrouterSource = { ...snapshot.source, usage: configuration.usage };
    const usable = ["success", "not_modified"].includes(snapshot.source.status) && snapshot.source.complete && snapshot.pagination.ended && snapshot.pagination.received === snapshot.pagination.total;
    if (usable && snapshot.source.retrieved_at) {
      const entries = new Map(snapshot.entries.map((entry) => [entry.source_model_id, entry]));
      currentOpenrouterEntries = entries;
      for (const fact of facts.values()) {
        const applicable = fact.identity.provider === "openrouter" && fact.identity.scope.route === "public" && fact.identity.scope.region === "global" && fact.identity.scope.plan === "public" && fact.identity.scope.protocol === "chat-completions";
        const entry = entries.get(fact.identity.request_model_id);
        if (fact.popularity.state === "known" && fact.popularity.source_id === "openrouter-weekly" && (!applicable || !entry)) fact.popularity = unknown("No applicable position in the current complete weekly snapshot; previous position is historical, not zero usage or model unavailability");
        if (applicable && entry) fact.popularity = { state: "known", value: { source_id: "openrouter-weekly", source_model_id: entry.source_model_id, position: entry.position, ranking_eligible: entry.ranking_eligible }, source_id: "openrouter-weekly", retrieved_at: snapshot.source.retrieved_at, data_as_of: snapshot.source.data_as_of, evidence: "Position in a complete OpenRouter all-models top-weekly snapshot; not a usage count or guaranteed population rank. Per-item coverage is separately gated." };
      }
    } else {
      if (previousOpenrouter) openrouterSource = { ...previousOpenrouter, status: snapshot.source.status, error: snapshot.source.error ?? "Retaining the last complete input while current collection is unavailable" };
      for (const previousFact of previous?.facts ?? []) {
        const current = facts.get(identityKey(previousFact.identity));
        if (current) current.popularity = structuredClone(previousFact.popularity);
      }
    }
  } else {
    openrouterSource = previousOpenrouter
      ? previousOpenrouter.status === "disabled" ? previousOpenrouter : { ...previousOpenrouter, status: "disabled", error: "No persisted local source snapshot; retaining verified last-good input and its provenance" }
      : { id: "openrouter-weekly", status: "disabled", url: configuration.endpoint, retrieved_at: null, data_as_of: null, window: { start: null, end: null }, usage: configuration.usage, complete: false, error: "No reviewed persisted source snapshot; transient probes are not production inputs" };
    for (const previousFact of previous?.facts ?? []) {
      const current = facts.get(identityKey(previousFact.identity));
      if (current) current.popularity = structuredClone(previousFact.popularity);
    }
  }
  // A retained snapshot cannot keep item-level ranking qualification after its review is
  // revoked. Keep the historical position/time while disabling its comparison eligibility.
  for (const fact of facts.values()) {
    if (fact.popularity.state === "known" && fact.popularity.source_id === "openrouter-weekly") fact.popularity.value.ranking_eligible = fact.popularity.value.ranking_eligible && configuration.ranking_evidence.length > 0 && configuration.ranked_ids.includes(fact.popularity.value.source_model_id);
  }
  const previousCapability = previous?.source_revisions.find((source) => source.id === "capability");
  const currentSources = [upstream.source, openrouterSource, previousCapability ? (previousCapability.status === "disabled" ? previousCapability : { ...previousCapability, status: "disabled" as const, error: "No current capability collector; retaining existing fact provenance" }) : { id: "capability", status: "disabled", retrieved_at: null, data_as_of: null, window: { start: null, end: null }, usage: { collection: "disabled", redistribution: "disabled", evidence: "Artificial Analysis candidate only; production rights and comparable profile not confirmed" }, complete: false } satisfies SourceRevision];
  const sourcesById = new Map(previous?.source_revisions.map((source) => [source.id, source]) ?? []);
  for (const source of currentSources) sourcesById.set(source.id, source);
  const attribution = new Map(previous?.attribution.map((entry) => [entry.source_id, entry]) ?? []);
  attribution.set("models-dev", { source_id: "models-dev", license: "MIT", url: "https://github.com/anomalyco/models.dev/blob/" + upstream.source.code_commit + "/LICENSE", text: "Copyright (c) 2025 models.dev; MIT license retained in repository LICENSE." });
  if (openrouterSource.usage.redistribution === "allowed" && (snapshot || previousOpenrouter)) attribution.set("openrouter-weekly", { source_id: "openrouter-weekly", license: options.fixture ? "Synthetic test fixture" : "See reviewed endpoint-specific usage evidence", url: openrouterSource.url ?? "https://openrouter.ai", text: options.fixture ? "Synthetic fixtures only. No real OpenRouter metrics." : "OpenRouter source order; " + openrouterSource.usage.evidence });
  else attribution.delete("openrouter-weekly");
  let rankingResult: ReturnType<typeof applyRankings> | undefined;
  const profilesById = new Map(previous?.metric_profiles.map(profile => [profile.id, profile]) ?? []);
  if (rankingInput) {
    const reviewedPolicy = observedPopularityPolicySchema.parse(await Bun.file(path.join(root, "cogine/config/popularity-policy.json")).json());
    if (stableStringify(reviewedPolicy) !== stableStringify(rankingInput.policy)) throw new Error("Ranking input policy differs from the reviewed current policy; collect a new fixed input instead of silently reweighting");
    const usage = await reviewedRankUsage(root);
    const snapshots = rankingInput.snapshots.map(snapshot => ({ ...snapshot, usage: usage.get(snapshot.source_id) ?? { collection: "unverified", redistribution: "unverified", evidence: "No current reviewed source policy" } })) as RankSourceSnapshot[];
    const catalogEntries = (source: string) => rankingInput.catalogs.filter(catalog => catalog.source_id === source && catalog.complete_response).map(catalog => ({ data: catalog.entries }));
    const vercelCatalogs = catalogEntries("vercel-ai-gateway");
    rankingResult = applyRankings({ facts: [...facts.values()], registryRows: upstream.registryRows, snapshots, catalogs: { openrouterCatalogs: catalogEntries("openrouter"), vercelCatalog: { data: vercelCatalogs.flatMap(catalog => catalog.data) } }, policy: rankingInput.policy, now: rankingInput.evaluation_date + "T00:00:00Z" });
    for (const source of rankingResult.sources) sourcesById.set(source.id, source);
    for (const profile of rankingResult.profiles) profilesById.set(profile.id, profile);
    for (const entry of rankingResult.attribution) attribution.set(entry.source_id, entry);
  }
  const modern = !!rankingInput || previous?.schema_version === 2;
  if (modern) {
    const usage = await reviewedRankUsage(root);
    for (const [id, authority] of usage) {
      const source = sourcesById.get(id);
      if (source) sourcesById.set(id, { ...source, usage: authority });
      for (const profile of profilesById.values()) if (profile.source_id === id) profile.usage = authority;
    }
  }
  const projectedFacts = rankingResult?.facts ?? [...facts.values()];
  // Current reviewed source permissions also apply when an entire input is retained.
  for (const source of sourcesById.values()) if (source.popularity_method) {
    const components = new Set(projectedFacts.flatMap(fact => fact.popularity.state === "known" && fact.popularity.source_id === source.id && fact.popularity.value.weighted ? Object.entries(fact.popularity.value.weighted.sources).filter(([, evidence]) => evidence.observed_days > 0).map(([id]) => id) : []));
    for (const field of ["collection", "redistribution"] as const) {
      const states = [...components].map(id => sourcesById.get(id)?.usage[field] ?? "unverified");
      source.usage[field] = states.includes("disabled") ? "disabled" : states.length && states.every(state => state === "allowed") ? "allowed" : "unverified";
    }
  }
  for (const fact of projectedFacts) if (fact.popularity.state === "known" && fact.popularity.value.ranking_eligible && !popularityCohortMatches(fact.popularity.value, sourcesById.get(fact.popularity.source_id))) fact.popularity.value.ranking_eligible = false;
  const candidate: Bundle = {
    schema_version: modern ? 2 : 1, revision: "0".repeat(64), builder_version: "modelspage-2.0.0", publication_sequence: options.sequence, published_at: options.publishedAt,
    source_revisions: [...sourcesById.values()].sort((a, b) => a.id.localeCompare(b.id, "en")), metric_profiles: [...profilesById.values()].sort((a, b) => a.id.localeCompare(b.id, "en")), attribution: [...attribution.values()].sort((a, b) => a.source_id.localeCompare(b.source_id, "en")),
    module_compatibility: modern ? { projection: 2, min_consumer_version: "2.0.0" } : { projection: 1, min_consumer_version: "1.0.0" },
    ...(rankingResult || previous?.ranking_defaults ? { ranking_defaults: rankingResult?.defaults ?? previous!.ranking_defaults } : {}),
    facts: applyCorrections(projectedFacts.sort((a, b) => identityKey(a.identity).localeCompare(identityKey(b.identity), "en")), corrections), mappings, corrections, fixture: !!options.fixture,
  };
  // Corrections remain immutable and authoritative. Do not silently rewrite a corrected
  // field to fit a new snapshot/configuration: stop for a higher reviewed correction instead.
  for (const fact of candidate.facts) {
    const popularity = fact.popularity;
    if (popularity.state !== "known" || popularity.source_id !== "openrouter-weekly" || !popularity.value.ranking_eligible) continue;
    const entry = currentOpenrouterEntries?.get(popularity.value.source_model_id);
    const qualified = configuration.ranking_evidence.length > 0 && configuration.ranked_ids.includes(popularity.value.source_model_id);
    const sameInput = openrouterSource.complete && popularity.retrieved_at === openrouterSource.retrieved_at && popularity.data_as_of === openrouterSource.data_as_of;
    const samePosition = !currentOpenrouterEntries || (entry?.ranking_eligible && entry.position === popularity.value.position);
    if (!qualified || !sameInput || !samePosition) throw new Error("Eligible OpenRouter popularity correction is stale or no longer reviewed; add a higher correction for the selected snapshot or retain it as historical ranking_eligible=false");
  }
  // Operational coverage describes dense source inputs. Clients receive only ranking/audit facts.
  const coverage = coverageReport(candidate);
  if (!options.fixture) candidate.facts = sparsePublicFacts(candidate.facts, mappings, corrections, options.publishedAt);
  coverage.published_fact_count = candidate.facts.length;
  candidate.revision = bundleRevision(candidate);
  const bundle = validateBundle(candidate);
  const bytes = stableStringify(bundle);
  const relativePath = `v1/revisions/${bundle.revision}/catalog.json`;
  const manifest = validateManifest({ schema_version: 1, revision: bundle.revision, publication_sequence: bundle.publication_sequence, published_at: bundle.published_at, objects: { catalog: { path: relativePath, sha256: sha256(bytes), size: Buffer.byteLength(bytes) } }, module_compatibility: bundle.module_compatibility, fixture: bundle.fixture });
  const target = path.join(options.outDir, relativePath);
  if (await Bun.file(target).exists() && await Bun.file(target).text() !== bytes) throw new Error("Refusing immutable revision path collision");
  await atomicWrite(target, bytes);
  await atomicWrite(path.join(options.outDir, "v1/manifest.json"), stableStringify(manifest));
  await atomicWrite(path.join(options.outDir, "reports/coverage.json"), stableStringify(coverage));
  await atomicWrite(path.join(options.outDir, "reports/coverage.md"), coverageMarkdown(coverage));
  if (rankingResult) await atomicWrite(path.join(options.outDir, "reports/rankings.json"), stableStringify({ input_sha256: sha256(stableStringify(rankingInput)), evaluation_date: rankingInput!.evaluation_date, method: rankingInput!.policy, defaults: rankingResult.defaults, issues: rankingResult.issues, public_distribution_ready: candidate.source_revisions.filter(source => rankingResult.sources.some(ranking => ranking.id === source.id)).every(source => source.usage.redistribution === "allowed") }));
  await atomicWrite(path.join(options.outDir, "reports/sources.json"), stableStringify({ revision: bundle.revision, fixture: bundle.fixture, sources: bundle.source_revisions, production_ready: false, deployment_verification: "external_configuration_and_live_verification_required", facts_publishable: !bundle.fixture && bundle.facts.every((fact) => ([fact.release, fact.capability, fact.popularity] as const).every((field) => field.state !== "known" || bundle.source_revisions.find((source) => source.id === field.source_id)?.usage.redistribution === "allowed")), remaining_configuration: ["Custom production domain and edge cache rules", "Dedicated R2 bucket and scoped credentials", "OpenRouter /models collection and redistribution review before enabling persisted production popularity", "Licensed comparable capability metric profile"] }));
  return { bundle, manifest, coverage };
}
