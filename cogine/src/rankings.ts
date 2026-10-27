import type { RankSourceEntry, RankSourceSnapshot } from "./adapters/rank-sources.js";
import { sha256, stableStringify } from "./integrity.js";
import { buildMetricIdentityRegistry, createSourceIdentityResolver, exactMetricCanonical, selectAaHeadline, type MetricIdentityRow, type SourceIdentityCatalogs } from "./metric-identity.js";
import { observedPopularity, observedPopularityPolicySchema, type ObservedPopularityPolicy } from "./observed-popularity.js";
import { validCalendarDate } from "./schema.js";
import { identityKey, unknown, type Bundle, type MetricProfile, type ModelFacts, type SourceRevision, type Usage } from "./types.js";

export type RankingIssue = { code: string; source_id?: string; canonical_id?: string; identity?: string; detail?: unknown };
export type ApplyRankingsInput = {
  facts: readonly ModelFacts[];
  registryRows: readonly MetricIdentityRow[];
  snapshots: readonly RankSourceSnapshot[];
  catalogs?: SourceIdentityCatalogs;
  policy: ObservedPopularityPolicy;
  now: string;
};
export type RankingsResult = {
  facts: ModelFacts[];
  sources: SourceRevision[];
  profiles: MetricProfile[];
  defaults: { capability_profile_id: string | null; popularity_source_id: string; policy_id: string };
  attribution: Bundle["attribution"];
  issues: RankingIssue[];
};

const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const numeric = (value: unknown): number | null => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = (value: string | null): value is string => !!value && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const protectedFact = (fact: ModelFacts["capability"] | ModelFacts["popularity"]) => fact.state === "withdrawn" || fact.state === "conflict";
const latestTime = (values: (string | null)[]) => values.filter(timestamp).sort((a, b) => Date.parse(b) - Date.parse(a) || order(a, b))[0] ?? null;
const citationUrls: Record<string, string> = {
  "artificial-analysis": "https://artificialanalysis.ai/data-api",
  "openrouter": "https://openrouter.ai/docs/api/api-reference/datasets/daily-token-totals-for-top-50-models",
  "vercel-ai-gateway": "https://vercel.com/ai-gateway/leaderboards",
  "opencode-go-free": "https://opencode.ai/data",
};
const policyUrl = "https://github.com/cogine-ai/modelspage/blob/main/cogine/config/popularity-policy.json";
type ObservedPoint = { source_model_id: string; date: string; metric: string; value: RankSourceEntry["value"]; denominator?: number; share: number; association_method: string };
type ObservedSourcePoints = { source_id: string; snapshot_sha256: string; points: ObservedPoint[] };

export function rankingDates(now: string, days = 7): string[] {
  if (!timestamp(now) || !Number.isSafeInteger(days) || days < 1 || days > 366) throw new Error("Rankings require a valid explicit clock and window");
  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
  return Array.from({ length: days }, (_, index) => new Date(today - (days - index) * 86_400_000).toISOString().slice(0, 10));
}
function sourceUsage(snapshot: RankSourceSnapshot): Usage {
  return { collection: snapshot.usage.collection === "allowed" ? "allowed" : "unverified", redistribution: snapshot.usage.redistribution, evidence: snapshot.usage.evidence };
}
function intersectUsage(sources: SourceRevision[]): Usage {
  const permission = (field: "collection" | "redistribution"): Usage[typeof field] => {
    if (sources.some(source => source.usage[field] === "disabled")) return "disabled";
    return sources.length && sources.every(source => source.usage[field] === "allowed") ? "allowed" : "unverified";
  };
  return { collection: permission("collection"), redistribution: permission("redistribution"), evidence: "Intersection of the actual observed component sources, including explicit zero observations; aggregation grants no additional collection or redistribution rights. " + sources.map(source => `${source.id}: ${source.usage.evidence}`).join("; ") };
}
function revision(snapshot: RankSourceSnapshot, digest: string): SourceRevision {
  return {
    id: snapshot.source_id,
    status: snapshot.status === "authentication_required" ? "failed" : snapshot.status,
    ...(snapshot.endpoints[0] ? { url: snapshot.endpoints[0] } : {}),
    retrieved_at: timestamp(snapshot.retrieved_at) ? snapshot.retrieved_at : null,
    data_as_of: timestamp(snapshot.data_as_of) ? snapshot.data_as_of : null,
    sha256: digest, window: { start: snapshot.window.start, end: snapshot.window.end }, usage: sourceUsage(snapshot),
    complete: snapshot.status === "success" && snapshot.complete_response,
    ...(snapshot.status !== "success" || !snapshot.complete_response ? { error: snapshot.issues.join("; ") || "Current source response is not complete; no new facts taken from this response" } : {}),
  };
}
function attribution(snapshot: RankSourceSnapshot): Bundle["attribution"][number] {
  const cc = snapshot.metadata.license === "CC-BY-4.0" || /CC[ -]BY[ -]4\.0/i.test(snapshot.usage.evidence);
  return { source_id: snapshot.source_id, license: cc ? "CC-BY-4.0" : "Source-specific data terms; redistribution " + snapshot.usage.redistribution, url: citationUrls[snapshot.source_id] ?? snapshot.endpoints[0] ?? policyUrl, text: `${snapshot.source_id}: ${snapshot.scope}. ${snapshot.usage.evidence} Identities normalized and observed daily token shares combined by Modelspage; source statistics are not whole-market or deduplicated usage. Source data_as_of=${snapshot.data_as_of ?? "unknown"}; retrieved_at=${snapshot.retrieved_at ?? "unknown"}.` + (cc ? " Licensed under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/ . Modelspage joined model identities and combined daily source shares using fixed weights." : "") };
}

/** Pure projection over the supplied upstream membership. Never reads a clock, network or private catalog. */
export function applyRankings(input: ApplyRankingsInput): RankingsResult {
  const policy = observedPopularityPolicySchema.parse(input.policy), dates = rankingDates(input.now, policy.window_days);
  if (new Set(input.facts.map(fact => identityKey(fact.identity))).size !== input.facts.length) throw new Error("Rankings input has duplicate exact fact identities");
  if (new Set(input.snapshots.map(snapshot => snapshot.source_id)).size !== input.snapshots.length) throw new Error("Rankings input has duplicate source snapshots; choose the effective last-good input first");
  const facts = structuredClone(input.facts) as ModelFacts[], registry = buildMetricIdentityRegistry(input.registryRows);
  const resolve = createSourceIdentityResolver(registry, input.catalogs), issues: RankingIssue[] = [];
  const snapshotById = new Map(input.snapshots.map(snapshot => [snapshot.source_id, snapshot]));
  const hashes = new Map(input.snapshots.map(snapshot => [snapshot.source_id, sha256(stableStringify(snapshot))]));
  const sources = input.snapshots.map(snapshot => revision(snapshot, hashes.get(snapshot.source_id)!));
  const sourcesById = new Map(sources.map(source => [source.id, source]));
  const usable = (snapshot: RankSourceSnapshot) => snapshot.status === "success" && snapshot.complete_response && timestamp(snapshot.retrieved_at);
  const aaByCanonical = new Map<string, RankSourceEntry[]>(), aaVersions = new Set<number>(), shares = new Map<string, Map<string, Map<string, number>>>();
  const evidence = new Map<string, Map<string, ObservedSourcePoints>>();
  const contributingSources = new Set<string>();
  const aaSnapshot = snapshotById.get("artificial-analysis"), activeAa = !!aaSnapshot && usable(aaSnapshot);
  let invalidAaVersion = false;
  let activeP = false;
  for (const snapshot of input.snapshots) {
    const sourceId = snapshot.source_id;
    for (const detail of snapshot.issues) issues.push({ code: "source_limitation", source_id: sourceId, detail });
    if (!usable(snapshot)) { issues.push({ code: "incomplete_source_not_scored", source_id: sourceId, detail: snapshot.status }); continue; }
    const isAa = sourceId === "artificial-analysis", isP = Object.hasOwn(policy.weights, sourceId);
    if (!isAa && !isP) continue;
    if (isP) activeP = true;
    const totals = new Map<string, number>();
    const rows = snapshot.metadata.daily_tokens_totals;
    if (Array.isArray(rows)) for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as { date?: unknown; total_tokens?: unknown };
      const total = numeric(row.total_tokens);
      if (typeof row.date !== "string" || !validCalendarDate(row.date, "day") || total === null || total <= 0) continue;
      if (totals.has(row.date)) throw new Error("Duplicate source daily token denominator");
      totals.set(row.date, total);
    }
    if (sourceId === "openrouter") {
      const sums = new Map<string, number>(), other = new Set<string>();
      for (const entry of snapshot.entries) if (entry.date && ["tokens", "total_tokens"].includes(entry.metric)) {
        const count = numeric(entry.value);
        if (count === null || count < 0) continue;
        sums.set(entry.date, (sums.get(entry.date) ?? 0) + count);
        if (entry.is_aggregate && ["other", "Other"].includes(entry.source_model_id)) other.add(entry.date);
      }
      for (const [date, total] of sums) if (!totals.has(date) && other.has(date) && total > 0) totals.set(date, total);
    }
    const seen = new Set<string>();
    for (const [entryIndex, entry] of snapshot.entries.entries()) {
      if (isAa && entry.metric === "artificial_analysis_intelligence_index" && numeric(entry.value) !== null) {
        const version = numeric(entry.index_version);
        if (version === null || version < 0) invalidAaVersion = true;
        else aaVersions.add(version);
      }
      const association = resolve(sourceId, entry);
      if (association.status === "ambiguous") issues.push({ code: "ambiguous_source_identity", source_id: sourceId, detail: { source_model_id: entry.source_model_id, association } });
      if (isAa && association.canonical_id && entry.metric === "artificial_analysis_intelligence_index") aaByCanonical.set(association.canonical_id, [...(aaByCanonical.get(association.canonical_id) ?? []), entry]);
      if (!isP || !entry.date || !dates.includes(entry.date) || !["tokens", "total_tokens"].includes(entry.metric)) continue;
      const duplicateKey = JSON.stringify([entry.source_model_id, entry.date]);
      if (seen.has(duplicateKey)) throw new Error("Duplicate source model/day token evidence cannot be counted twice");
      seen.add(duplicateKey);
      if (!association.canonical_id) continue;
      const value = numeric(entry.value);
      if (value === null || value < 0) { issues.push({ code: "invalid_source_value", source_id: sourceId, detail: { entry_index: entryIndex, entry } }); continue; }
      const denominator = sourceId === "vercel-ai-gateway" ? undefined : totals.get(entry.date);
      if (sourceId !== "vercel-ai-gateway" && !denominator) { issues.push({ code: "source_daily_denominator_missing", source_id: sourceId, detail: { date: entry.date, source_model_id: entry.source_model_id } }); continue; }
      const share = denominator === undefined ? value : 100 * value / denominator;
      if (!Number.isFinite(share) || share > 100) throw new Error("Invalid source daily token share");
      const canonical = association.canonical_id;
      if (!shares.has(canonical)) shares.set(canonical, new Map());
      const bySource = shares.get(canonical)!;
      if (!bySource.has(sourceId)) bySource.set(sourceId, new Map());
      const daily = bySource.get(sourceId)!;
      const sum = (daily.get(entry.date) ?? 0) + share;
      if (sum > 100.000001) throw new Error("Canonical source daily shares exceed their platform denominator");
      daily.set(entry.date, sum);
      if (!evidence.has(canonical)) evidence.set(canonical, new Map());
      const sourcePoints = evidence.get(canonical)!;
      if (!sourcePoints.has(sourceId)) sourcePoints.set(sourceId, { source_id: sourceId, snapshot_sha256: hashes.get(sourceId)!, points: [] });
      sourcePoints.get(sourceId)!.points.push({ source_model_id: entry.source_model_id, date: entry.date, metric: entry.metric, value: entry.value, ...(denominator === undefined ? {} : { denominator }), share, association_method: association.method });
      if (policy.weights[sourceId]! > 0) contributingSources.add(sourceId);
    }
  }
  const profiles: MetricProfile[] = [];
  let profile: MetricProfile | null = null;
  if (activeAa && !invalidAaVersion && aaVersions.size === 1) {
    const version = [...aaVersions][0]!;
    profile = { id: `artificial-analysis-intelligence-index-v${version}-source-headline-v1`, source_id: "artificial-analysis", name: `Artificial Analysis Intelligence Index v${version} — source headline`, metric: "intelligence-index", method_version: String(version), direction: "higher", task: "AA composite Intelligence Index", model_snapshot: "Per-model AA source_model_id retained in each capability fact", inference_config: "Per-model source headline/configuration retained in each capability fact", evaluation_conditions: "Compare unique source headlines within the same published AA index version; retain reasoning/effort alternatives without selecting the maximum. AA API major.minor version does not disclose patch-level evaluation changes.", usage: sourceUsage(aaSnapshot!), comparison_policy: "source-headline-v1" };
    profiles.push(profile);
  } else if (activeAa) issues.push({ code: "aa_index_versions_incomparable", source_id: "artificial-analysis", detail: { versions: [...aaVersions].sort(), invalid_or_missing: invalidAaVersion } });
  const scores = new Map([...shares].map(([canonical, values]) => [canonical, observedPopularity(policy, dates, values)]));
  const distinctScores = [...new Set([...scores.values()].flatMap(score => score.score === null ? [] : [score.score]))].sort((a, b) => b - a);
  const positions = new Map(distinctScores.map((score, index) => [score, index + 1]));
  const contributors = [...contributingSources].sort(order).map(id => sourcesById.get(id)!);
  const composite: SourceRevision = { id: policy.id, status: "success", url: policyUrl, retrieved_at: latestTime(contributors.map(source => source.retrieved_at)), data_as_of: null, sha256: sha256(stableStringify({ policy, dates, source_hashes: contributors.map(source => [source.id, source.sha256]), registry_sha256: sha256(stableStringify(input.registryRows)), catalogs_sha256: sha256(stableStringify(input.catalogs ?? {})) })), window: { start: dates[0]!, end: dates.at(-1)! }, popularity_method: { id: policy.id, dates, weights: { ...policy.weights } }, usage: intersectUsage(contributors), complete: true };
  sources.push(composite);
  for (const fact of facts) {
    const identity = fact.identity, scope = identity.scope;
    if (scope.route !== "public" || scope.region !== "global" || scope.plan !== "public") continue;
    const canonical = fact.canonical_id;
    if (!canonical) continue;
    const declared = exactMetricCanonical(registry, [identity.provider], identity.request_model_id);
    if (declared.canonical_id !== canonical) { issues.push({ code: "target_identity_conflict_or_missing", identity: identityKey(identity), canonical_id: canonical, detail: declared }); continue; }
    if (!protectedFact(fact.capability) && activeAa) {
      const candidates = aaByCanonical.get(canonical) ?? [];
      const headline = selectAaHeadline(canonical, candidates, aaVersions);
      const selected = profile ? headline.selected : null;
      if (selected && aaSnapshot!.retrieved_at) {
        const configuration = { source_model_id: selected.source_model_id, source_slug: selected.source_slug ?? null, source_name: selected.display_name ?? null, configuration: /\(([^()]*)\)$/.exec(selected.display_name ?? "")?.[1] ?? null };
        fact.capability = { state: "known", source_id: "artificial-analysis", retrieved_at: aaSnapshot!.retrieved_at, data_as_of: timestamp(aaSnapshot!.data_as_of) ? aaSnapshot!.data_as_of : null, value: { profile_id: profile!.id, score: Number(selected.value), model_snapshot: selected.source_model_id, inference_config: stableStringify(configuration).trim() }, evidence: stableStringify({ policy: "source-headline-v1", index_version: profile!.method_version, canonical_id: canonical, snapshot_sha256: hashes.get("artificial-analysis"), raw_sha256: aaSnapshot!.raw_files.map(file => file.sha256), selected_entry: { source_model_id: selected.source_model_id, source_slug: selected.source_slug, display_name: selected.display_name, metric: selected.metric, value: selected.value, index_version: selected.index_version }, alternatives: headline.configurations.map(entry => ({ source_model_id: entry.source_model_id, source_slug: entry.source_slug, configuration: /\(([^()]*)\)$/.exec(entry.display_name ?? "")?.[1] ?? null, value: entry.value })), configuration, association_method: resolve("artificial-analysis", selected).method }).trim() };
      } else fact.capability = unknown(profile ? "No unique comparable AA source headline for this canonical model; missing is not zero" : "AA index version is missing or not comparable within one numeric version");
    }
    if (!protectedFact(fact.popularity) && activeP) {
      const result = scores.get(canonical);
      if (result?.score !== null && result?.score !== undefined && composite.retrieved_at) {
        fact.popularity = { state: "known", source_id: policy.id, retrieved_at: composite.retrieved_at, data_as_of: null, value: { source_id: policy.id, source_model_id: canonical, position: positions.get(result.score)!, ranking_eligible: policy.weights_status === "accepted", weighted: { method_id: policy.id, score: result.score, dates, weights: { ...policy.weights }, sources: result.evidence } }, evidence: stableStringify({ method_id: policy.id, rank_kind: "dense-composite-score", canonical_id: canonical, composite_sha256: composite.sha256, source_entries: [...(evidence.get(canonical)?.values() ?? [])].sort((a, b) => order(a.source_id, b.source_id)) }).trim() };
      } else fact.popularity = unknown("No observed source/day token-share evidence in the complete UTC window; missing is not zero");
    }
  }
  if (policy.weights_status !== "accepted") issues.push({ code: "popularity_policy_not_accepted", detail: policy.id });
  return { facts, sources: sources.sort((a, b) => order(a.id, b.id)), profiles, defaults: { capability_profile_id: profile?.id ?? null, popularity_source_id: policy.id, policy_id: policy.id }, attribution: [...input.snapshots.map(attribution), { source_id: policy.id, license: "Aggregation code: MIT; component data retains its source-specific terms", url: policyUrl, text: "Modelspage computes a fixed-weight union of observed source/day token shares. Missing values stay unknown. Dense composite positions are not source-native usage ranks. " + composite.usage.evidence }].sort((a, b) => order(a.source_id, b.source_id)), issues };
}
