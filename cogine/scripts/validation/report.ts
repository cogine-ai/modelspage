import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { generateV2 } from "../../../packages/core/src/generate-v2.js";
import { validCalendarDate } from "../../src/schema.js";
import { atomicWrite, sha256, stableStringify } from "../../src/integrity.js";
import { observedPopularity, observedPopularityPolicySchema } from "../../src/observed-popularity.js";

// This diagnostic report deliberately does not publish a production Bundle or
// change a consumer's available membership, request IDs, routes or selected model.
type Row = Record<string, any>;
type Registry = { records: Row[]; canonicals: Map<string, Row[]>; byProviderId: Map<string, Row[]>; slugKeys: Map<string, Set<string>>; hfKeys: Map<string, Set<string>>; source: Row };
type Link = { status: "matched" | "unmatched" | "ambiguous"; canonical_id: string | null; method: string; candidates: string[] };
const protocolNames: Record<string, string> = { chat_completions: "chat-completions", anthropic_messages: "messages", responses: "responses", gemini: "generate-content" };
const normalized = (value: string) => (value.normalize("NFKC").toLowerCase().match(/[a-z]+|[0-9]+/g) ?? []).join("-");
const pairKey = (provider: string, id: string) => JSON.stringify([provider, id]);
const add = (index: Map<string, Set<string>>, key: string, value: string) => { if (key) index.set(key, new Set([...(index.get(key) ?? []), value])); };
const numeric = (value: unknown) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
function linkFrom(candidates: Iterable<string>, method: string): Link {
  const values = [...new Set(candidates)].sort();
  return { status: values.length === 1 ? "matched" : values.length ? "ambiguous" : "unmatched", canonical_id: values.length === 1 ? values[0]! : null, method, candidates: values };
}
export function canonicalKeys(canonical: string) {
  const short = canonical.slice(canonical.indexOf("/") + 1);
  const keys = [normalized(short)];
  // AA and models.dev use both orders for the same explicit Claude family/version.
  const claude = /^claude-(sonnet|opus|haiku)-(.+)$/.exec(short);
  if (claude) keys.push(normalized(`claude-${claude[2]}-${claude[1]}`));
  return keys;
}
function weightsUrl(value: string) { try { const u = new URL(value); return `${u.origin}${u.pathname.replace(/\/$/, "")}`; } catch { return value; } }
export function aaVariantBase(slug: string, displayName: string): string | null {
  const configuration = /\(([^()]*)\)$/.exec(displayName)?.[1];
  if (!configuration || !/^(?:(?:Non-reasoning|Reasoning|Minimal|Low|Medium|High|Xhigh|Max)(?:,\s*(?:Low|High|Default Fallback))?)$/i.test(configuration)) return null;
  const match = /-(non-reasoning-low-effort|non-reasoning|minimal|medium|xhigh|reasoning|adaptive|thinking|low|high|max)$/.exec(slug);
  return match ? slug.slice(0, -match[0].length) : null;
}
async function registry(root: string, directory: string): Promise<Registry> {
  const latestFile = join(directory, "inputs/upstream-latest.json");
  let data: Row;
  try { data = JSON.parse(await readFile(latestFile, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const lock = await Bun.file(join(root, "cogine/upstream.lock.json")).json();
    const providers = await generateV2(join(root, "providers"));
    data = { source: { commit: lock.commit, latest_remote_verified: false, kind: "pinned_fallback_reference" }, providers: Object.entries(providers).map(([id, p]) => ({ id, name: p.name, models: Object.entries(p.models).map(([id, m]) => ({ id, name: m.name, canonical_id: m.canonical_id, release_date: m.release_date, api_protocols: Object.keys(m.api) })) })) };
  }
  if (!Array.isArray(data.providers) || !data.providers.length) throw new Error("Upstream reference has no parsed provider records; inspect its schema diagnostics before reporting coverage");
  const records: Row[] = [], canonicals = new Map<string, Row[]>(), byProviderId = new Map<string, Row[]>(), slugKeys = new Map<string, Set<string>>(), hfKeys = new Map<string, Set<string>>();
  for (const provider of data.providers) for (const model of provider.models) {
    const record = { ...model, provider_id: provider.id };
    records.push(record);
    const key = pairKey(provider.id, model.id);
    byProviderId.set(key, [...(byProviderId.get(key) ?? []), record]);
    if (!model.canonical_id) continue;
    canonicals.set(model.canonical_id, [...(canonicals.get(model.canonical_id) ?? []), record]);
    for (const alias of canonicalKeys(model.canonical_id)) add(slugKeys, alias, model.canonical_id);
    for (const weight of model.weights ?? []) if (typeof weight.url === "string") add(hfKeys, weightsUrl(weight.url), model.canonical_id);
  }
  return { records, canonicals, byProviderId, slugKeys, hfKeys, source: { ...data.source, parse_status: data.status ?? "success", counts: data.counts, schema_diagnostics: data.schema_diagnostics } };
}
function exactCanonical(reg: Registry, providerIds: string[], id: string): Link {
  return linkFrom(providerIds.flatMap(provider => (reg.byProviderId.get(pairKey(provider, id)) ?? []).flatMap(row => row.canonical_id ? [row.canonical_id] : [])), "exact_upstream_provider_record");
}
async function optionalJson(path: string): Promise<Row | null> { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
async function sourceLinks(reg: Registry, sourceDir: string) {
  const orAliases = new Map<string, Set<string>>();
  const orCatalog = await optionalJson(join(sourceDir, "openrouter/models-top-weekly-diagnostic.json"));
  for (const row of orCatalog?.data ?? []) {
    if (!row.id) continue;
    const canonical = exactCanonical(reg, ["openrouter"], row.id);
    if (!canonical.canonical_id) continue;
    add(orAliases, row.id, canonical.canonical_id);
    if (row.canonical_slug) add(orAliases, row.canonical_slug, canonical.canonical_id);
  }
  const vercelNames = new Map<string, Set<string>>();
  const catalog = await optionalJson(join(sourceDir, "vercel-ai-gateway/catalog-public.json"));
  for (const row of catalog?.data ?? []) {
    if (!row.id || !row.name) continue;
    const found = exactCanonical(reg, ["vercel"], row.id);
    if (found.canonical_id) add(vercelNames, row.name, found.canonical_id);
  }
  // This fallback is scoped to Vercel's own explicit upstream records; it does
  // not match arbitrary global display names or remove semantic suffixes.
  for (const record of reg.records.filter(row => row.provider_id === "vercel" && row.canonical_id)) add(vercelNames, record.name, record.canonical_id);
  return (sourceId: string, entry: Row): Link => {
    if (entry.is_aggregate || entry.source_model_id === "other" || entry.source_model_id === "Other") return linkFrom([], "aggregate_other_is_not_a_model");
    if (sourceId === "vercel-ai-gateway") return linkFrom(vercelNames.get(entry.source_model_id) ?? [], "vercel_source_name_to_its_catalog_id");
    if (sourceId === "opencode-go-free") return exactCanonical(reg, ["opencode-go", "opencode"], entry.source_model_id);
    if (sourceId === "openrouter") {
      const bridged = orAliases.get(entry.source_model_id);
      return bridged?.size ? linkFrom(bridged, "openrouter_canonical_slug_bridge") : exactCanonical(reg, ["openrouter"], entry.source_model_id);
    }
    const associations = entry.associations ?? {};
    if (associations.openrouter_api_id) {
      const found = exactCanonical(reg, ["openrouter"], associations.openrouter_api_id);
      if (found.status !== "unmatched") return { ...found, method: "aa_declared_openrouter_api_id" };
    }
    if (associations.huggingface_url) {
      const found = linkFrom(reg.hfKeys.get(weightsUrl(associations.huggingface_url)) ?? [], "aa_declared_weights_url");
      if (found.status !== "unmatched") return found;
    }
    const direct = linkFrom(reg.slugKeys.get(normalized(entry.source_slug ?? "")) ?? [], "aa_exact_model_slug_with_claude_family_order_alias");
    if (direct.status !== "unmatched") return direct;
    const base = aaVariantBase(entry.source_slug ?? "", entry.display_name ?? "");
    return base ? linkFrom(reg.slugKeys.get(normalized(base)) ?? [], "aa_configuration_suffix_candidate_not_runtime_verification") : direct;
  };
}
export function completeDays(now: string, count = 7) {
  if (!Number.isFinite(Date.parse(now)) || !Number.isSafeInteger(count) || count < 1 || count > 366) throw new Error("Invalid complete-day window");
  const today = Date.parse(now.slice(0, 10) + "T00:00:00Z");
  return Array.from({ length: count }, (_, index) => new Date(today - (count - index) * 86_400_000).toISOString().slice(0, 10));
}
export function meanCompleteShares(values: Map<string, number>, dates: string[]) {
  if (!dates.length || new Set(dates).size !== dates.length) throw new Error("A unique nonempty date window is required");
  if (dates.some(date => !values.has(date) || !Number.isFinite(values.get(date)) || values.get(date)! < 0 || values.get(date)! > 100)) return null;
  return dates.reduce((sum, date) => sum + values.get(date)!, 0) / dates.length;
}
function datePrecision(date: unknown): "day" | "month" | "year" | null {
  if (typeof date !== "string") return null;
  for (const precision of ["day", "month", "year"] as const) if (validCalendarDate(date, precision)) return precision;
  return null;
}
function compareNumber(a: number | null, b: number | null) { return a === null ? b === null ? 0 : 1 : b === null ? -1 : b - a; }
const csv = (value: unknown) => {
  const text = String(value ?? "");
  return `"${(/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
};
function csvTable(rows: Row[], columns: string[]) { return "\uFEFF" + [columns.map(csv).join(","), ...rows.map(row => columns.map(c => csv(typeof row[c] === "object" ? stableStringify(row[c]).trim() : row[c])).join(","))].join("\n"); }
function displayDateRank(row: Row, now: string) { return row.n_precision === "day" && row.n_date <= now.slice(0, 10) ? Date.parse(row.n_date) : null; }
export function compareReportRows(a: Row, b: Row, field: "c_score" | "p_trial_score" | "n_date", now: string): number {
  return (field === "n_date" ? compareNumber(displayDateRank(a, now), displayDateRank(b, now)) : compareNumber(a[field], b[field]))
    || (field === "p_trial_score" ? compareNumber(a.c_score, b.c_score) : 0)
    || compareNumber(displayDateRank(a, now), displayDateRank(b, now))
    || a.provider_order - b.provider_order
    || a.source_position - b.source_position
    || (a.request_model_id < b.request_model_id ? -1 : a.request_model_id > b.request_model_id ? 1 : 0);
}

export async function generateReport(directory: string, outDir: string, now: string, popularityDays?: number) {
  const root = process.cwd(), inventory = await Bun.file(join(directory, "inputs/coginework-providers.json")).json();
  const refreshIndex = await Bun.file(join(directory, "refresh/index.json")).json();
  const sourceIndex = await Bun.file(join(directory, "sources/index.json")).json();
  const reg = await registry(root, directory), associate = await sourceLinks(reg, join(directory, "sources"));
  const implementationHashes: Record<string, string> = {};
  for (const file of ["cogine/scripts/validation/inventory.py", "cogine/scripts/validation/refresh.ts", "cogine/scripts/validation/rank-sources.ts", "cogine/scripts/validation/upstream-reference.ts", "cogine/scripts/validation/report.ts", "cogine/src/integrity.ts", "cogine/src/schema.ts", "cogine/src/observed-popularity.ts", "cogine/config/popularity-policy.json"]) implementationHashes[file] = sha256(await readFile(join(root, file)));
  const configuredPolicy = await Bun.file(join(root, "cogine/config/popularity-policy.json")).json();
  const popularityPolicy = observedPopularityPolicySchema.parse({ ...configuredPolicy, ...(popularityDays !== undefined ? { window_days: popularityDays } : {}) });
  const problems: Row[] = [], sources: Row[] = [], sourceEntries: Row[] = [];
  for (const issue of reg.source.schema_diagnostics?.incompatible_files ?? []) problems.push({ code: "latest_upstream_schema_incompatible", source: "models.dev", detail: issue });
  const runNotes = await optionalJson(join(directory, "refresh/run-notes.json"));
  if (runNotes) problems.push({ code: "refresh_process_observations", detail: runNotes });
  problems.push({ code: "production_cpn_pipeline_incomplete", detail: "AA adapter, canonical score projection and multisource weighted P are not implemented in the production builder; this harness is diagnostic only" });
  if (popularityPolicy.weights_status === "proposed") problems.push({ code: "popularity_weights_proposed", detail: popularityPolicy.weights });
  if (inventory.providers.length !== inventory.summary.provider_count || new Set(inventory.providers.map((p: Row) => p.id)).size !== inventory.providers.length) throw new Error("CogineWork inventory is incomplete or duplicated");
  if (refreshIndex.results.length !== inventory.providers.length) throw new Error("Every registered Provider requires a refresh result, including failures");
  const activeDates = completeDays(now, popularityPolicy.window_days);
  const evidenceDates = completeDays(now, Math.max(7, popularityPolicy.window_days));
  const aaByCanonical = new Map<string, Row[]>();
  const shares = new Map<string, Map<string, Map<string, number>>>();
  const observedDates = new Map<string, Set<string>>();
  const nativeRanks = new Map<string, Map<string, Row[]>>();
  const shareOrigins = new Map<string, Set<string>>();
  function recordShare(source: string, canonical: string, date: string, share: number) {
    if (!Number.isFinite(share) || share < 0 || share > 100.000001) { problems.push({ code: "invalid_source_share", source, canonical, date }); return; }
    if (!shares.has(source)) shares.set(source, new Map());
    const byCanonical = shares.get(source)!;
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, new Map());
    const values = byCanonical.get(canonical)!;
    values.set(date, (values.get(date) ?? 0) + share);
  }
  for (const source of sourceIndex.sources) {
    const snapshot = await Bun.file(join(directory, "sources", source.snapshot_path)).json();
    sources.push({ ...source, scope: snapshot.scope, window: snapshot.window, usage: snapshot.usage });
    for (const issue of snapshot.issues ?? []) problems.push({ code: "source_limitation", source: source.source_id, detail: issue });
    const scoreEligible = snapshot.status === "success" && snapshot.complete_response === true;
    if (!scoreEligible) problems.push({ code: "incomplete_source_not_scored", source: source.source_id, status: snapshot.status, detail: "Partial observations remain visible as associations, but do not produce C/P known scores" });
    const totals = new Map<string, number>();
    for (const item of snapshot.metadata?.daily_tokens_totals ?? []) totals.set(item.date, Number(item.total_tokens));
    if (source.source_id === "openrouter") {
      const reconstructed = new Map<string, number>();
      const hasOther = new Set<string>();
      for (const entry of snapshot.entries) if (entry.date && entry.is_aggregate && ["other", "Other"].includes(entry.source_model_id)) hasOther.add(entry.date);
      for (const entry of snapshot.entries) if (entry.date && (entry.metric === "total_tokens" || entry.metric === "tokens")) reconstructed.set(entry.date, (reconstructed.get(entry.date) ?? 0) + (numeric(entry.value) ?? 0));
      for (const [date, total] of reconstructed) if (!totals.has(date) && scoreEligible && hasOther.has(date)) totals.set(date, total);
    }
    for (const entry of snapshot.entries) {
      const association = associate(source.source_id, entry);
      sourceEntries.push({ source_id: source.source_id, ...entry, association });
      if (!scoreEligible) continue;
      if (entry.date && evidenceDates.includes(entry.date) && ["tokens", "total_tokens"].includes(entry.metric)) {
        if (!observedDates.has(source.source_id)) observedDates.set(source.source_id, new Set());
        observedDates.get(source.source_id)!.add(entry.date);
      }
      if (!association.canonical_id) continue;
      const canonical = association.canonical_id;
      if (source.source_id === "artificial-analysis") aaByCanonical.set(canonical, [...(aaByCanonical.get(canonical) ?? []), { ...entry, association }]);
      if (entry.source_rank && entry.window_label === "pastWeek") {
        if (!nativeRanks.has(source.source_id)) nativeRanks.set(source.source_id, new Map());
        const ranks = nativeRanks.get(source.source_id)!;
        ranks.set(canonical, [...(ranks.get(canonical) ?? []), { source_model_id: entry.source_model_id, source_rank: entry.source_rank, window_label: entry.window_label }]);
      }
      if (!entry.date || !evidenceDates.includes(entry.date)) continue;
      if (entry.metric !== "tokens" && entry.metric !== "total_tokens") continue;
      const originKey = JSON.stringify([source.source_id, canonical, entry.date]);
      const origins = shareOrigins.get(originKey) ?? new Set<string>();
      if (origins.has(entry.source_model_id)) throw new Error("Duplicate model/day token rows cannot be counted twice");
      origins.add(entry.source_model_id); shareOrigins.set(originKey, origins);
      if (source.source_id === "vercel-ai-gateway" && numeric(entry.value) !== null) recordShare(source.source_id, canonical, entry.date, Number(entry.value));
      if ((source.source_id === "opencode-go-free" || source.source_id === "openrouter") && numeric(entry.value) !== null) {
        if ((totals.get(entry.date) ?? 0) > 0) recordShare(source.source_id, canonical, entry.date, 100 * Number(entry.value) / totals.get(entry.date)!);
        else problems.push({ code: "source_daily_denominator_missing", source: source.source_id, detail: { date: entry.date, source_model_id: entry.source_model_id } });
      }
    }
  }
  for (const [key, origins] of shareOrigins) if (origins.size > 1) problems.push({ code: "source_routes_aggregated_to_canonical", detail: { key: JSON.parse(key), source_model_ids: [...origins] } });
  const aaVersions = new Set([...aaByCanonical.values()].flat().filter(entry => numeric(entry.value) !== null).map(entry => entry.index_version));
  if (aaVersions.size > 1 || aaVersions.has(undefined)) problems.push({ code: "aa_index_versions_incomparable", detail: [...aaVersions] });
  // Fixed global weights; take the union of any observed source/day. Missing
  // evidence never vetoes another source and never causes weight renormalization.
  const trialSources = Object.keys(popularityPolicy.weights);
  for (const source of trialSources) {
    const missingDates = activeDates.filter(date => !observedDates.get(source)?.has(date));
    if (missingDates.length) problems.push({ code: "popularity_source_window_incomplete", source, detail: { missing_dates: missingDates, policy: "Retain the configured weight and explicit missing evidence; other sources can still contribute" } });
  }
  const rows: Row[] = [], providers: Row[] = [];
  for (const provider of inventory.providers) {
    const summary = refreshIndex.results.find((item: Row) => item.provider_id === provider.id);
    if (!summary) throw new Error(`Missing refresh result for ${provider.id}`);
    const result = await Bun.file(summary.path).json();
    const fresh = result.status === "refreshed" && result.membership_complete;
    const effective = fresh ? result.models : result.fallback.models;
    const effectiveIds = new Set(effective.map((model: Row) => model.id));
    const diagnosticModels = effective.map((model: Row) => ({ model, client_context: true, basis: fresh ? "live_catalog_client_projection" : "packaged_fallback_not_latest" }));
    if (fresh) {
      const membership = new Map((result.live_membership_models ?? []).map((model: Row) => [model.id, model]));
      for (const id of result.listed_model_ids) if (!effectiveIds.has(id)) diagnosticModels.push({ model: membership.get(id) ?? { id, model_protocol: "unknown" }, client_context: false, basis: "live_source_catalog_excluded_by_client" });
    } else if (provider.refresh_class === "catalog_only" && provider.modelsdev_provider) {
      // Latest upstream reference data is useful for coverage, but never grants
      // plan/account membership or replaces the client's packaged selection set.
      for (const reference of reg.records.filter(row => row.provider_id === provider.modelsdev_provider)) if (!effectiveIds.has(reference.id)) diagnosticModels.push({ model: { id: reference.id, name: reference.name, model_protocol: "unknown" }, client_context: false, basis: "latest_upstream_reference_not_api_membership" });
    }
    const seen = new Set<string>();
    if (!fresh) problems.push({ code: "provider_refresh_unavailable", provider: provider.id, status: result.status, detail: result.reason });
    for (const issue of result.issues ?? []) problems.push({ ...issue, provider: provider.id });
    const providerRows: Row[] = [];
    for (let position = 0; position < diagnosticModels.length; position++) {
      const { model, client_context: clientContext, basis } = diagnosticModels[position]!;
      if (seen.has(model.id)) throw new Error(`Duplicate effective model in ${provider.id}`);
      seen.add(model.id);
      const mapped = provider.modelsdev_provider;
      const upstreamRecords = mapped ? reg.byProviderId.get(pairKey(mapped, model.id)) ?? [] : [];
      const canonical = linkFrom(upstreamRecords.flatMap(row => row.canonical_id ? [row.canonical_id] : []), "declared_coginework_provider_route_and_exact_model_id");
      const dates = [...new Set(upstreamRecords.map(row => row.release_date).filter(Boolean))];
      const nDate = dates.length === 1 ? dates[0] : null;
      const candidateRecords = canonical.canonical_id ? aaByCanonical.get(canonical.canonical_id) ?? [] : [];
      const exactSlug = candidateRecords.filter(entry => canonicalKeys(canonical.canonical_id!).includes(normalized(entry.source_slug ?? "")));
      const aaCandidates = exactSlug.length ? exactSlug : candidateRecords;
      const allAaConfigurations = [...new Map(candidateRecords.filter(entry => numeric(entry.value) !== null).map(entry => [entry.source_model_id, entry])).values()];
      const uniqueAa = [...new Map(aaCandidates.filter(entry => numeric(entry.value) !== null).map(entry => [entry.source_model_id, entry])).values()];
      const aa = uniqueAa.length === 1 && aaVersions.size === 1 && !aaVersions.has(undefined) ? uniqueAa[0]! : null;
      const modelShares = new Map(trialSources.flatMap(source => {
        const values = canonical.canonical_id ? shares.get(source)?.get(canonical.canonical_id) : undefined;
        return values ? [[source, values] as const] : [];
      }));
      const popularity = observedPopularity(popularityPolicy, activeDates, modelShares);
      const pValues = Object.fromEntries(Object.entries(popularity.evidence).map(([source, evidence]) => [source, evidence.score]));
      const pTrial = popularity.score;
      const protocol = protocolNames[model.model_protocol] ?? model.model_protocol ?? provider.default_protocol;
      const row: Row = { provider_id: provider.id, provider_name: provider.name, provider_order: provider.order, request_model_id: model.id, display_name: model.name ?? model.id, model_protocol: protocol, source_position: position, included_in_client_context: clientContext, account_availability: "not_evaluated", provider_selector_declared_visible: provider.show_in_selector ?? null, provider_restricted_in_default_manager: provider.restricted_in_default_manager ?? null, provider_catalog_status: provider.catalog_status ?? null, inventory_basis: basis, latest_refreshed: fresh, refresh_status: result.status, modelsdev_provider: mapped, upstream_record_found: upstreamRecords.length > 0, upstream_parse_status: upstreamRecords[0]?.parse_status ?? (upstreamRecords.length ? "validated" : "missing"), canonical_id: canonical.canonical_id, canonical_status: canonical.status, canonical_candidates: canonical.candidates, n_date: nDate, n_precision: datePrecision(nDate), n_source: upstreamRecords.length ? reg.source.commit : null, c_score: aa ? Number(aa.value) : null, c_status: aa ? "aa_headline_reference_trial" : uniqueAa.length > 1 ? "ambiguous_aa_variants" : "unknown", c_aa_id: aa?.source_model_id ?? null, c_aa_slug: aa?.source_slug ?? null, c_aa_name: aa?.display_name ?? null, c_index_version: aa?.index_version ?? null, c_alternatives: uniqueAa.map(a => ({ id: a.source_model_id, slug: a.source_slug, name: a.display_name, score: a.value, index_version: a.index_version })), p_trial_score: pTrial, p_trial_status: pTrial !== null ? "observed_weighted_union" : "unknown_no_observed_popularity_evidence", p_source_scores: pValues, p_source_evidence: popularity.evidence, p_observed_sources: popularity.observed_sources, p_observed_source_weight: popularity.observed_source_weight, p_observed_day_weight: popularity.observed_day_weight, p_native_ranks: Object.fromEntries([...nativeRanks].flatMap(([source, ranks]) => canonical.canonical_id && ranks.has(canonical.canonical_id) ? [[source, ranks.get(canonical.canonical_id)]] : [])), original_model: model };
      row.n_eligible = displayDateRank(row, now) !== null;
      row.p_sort_basis = pTrial !== null ? "popularity" : row.c_score !== null ? "capability_fallback" : row.n_eligible ? "release_fallback" : "stable_default_order";
      if (!mapped) problems.push({ code: "no_declared_modelsdev_provider_route", provider: provider.id, model: model.id });
      else if (!upstreamRecords.length) problems.push({ code: "model_missing_from_latest_upstream_provider", provider: provider.id, upstream_provider: mapped, model: model.id });
      else if (!canonical.canonical_id) problems.push({ code: canonical.status === "ambiguous" ? "ambiguous_canonical" : "upstream_record_has_no_base_model", provider: provider.id, model: model.id });
      row.c_configuration_policy = "pending; exact canonical slug headline used for diagnostic comparison when unique; never maximum score";
      row.c_alternatives = allAaConfigurations.map(a => ({ id: a.source_model_id, slug: a.source_slug, name: a.display_name, configuration: /\(([^()]*)\)$/.exec(a.display_name ?? "")?.[1] ?? null, score: a.value, index_version: a.index_version, association: a.association }));
      row.p_missing_source_days = Object.fromEntries(trialSources.map(source => [source, activeDates.filter(date => !canonical.canonical_id || !shares.get(source)?.get(canonical.canonical_id)?.has(date))]));
      if (canonical.canonical_id && !allAaConfigurations.length) problems.push({ code: "aa_score_missing_for_canonical", provider: provider.id, model: model.id, detail: canonical.canonical_id });
      if (canonical.canonical_id && pTrial === null) problems.push({ code: "p_no_observed_source_evidence", provider: provider.id, model: model.id, detail: row.p_missing_source_days });
      if (allAaConfigurations.length > 1) problems.push({ code: "multiple_aa_configurations_need_policy", provider: provider.id, model: model.id, detail: { aa_ids: allAaConfigurations.map(entry => entry.source_model_id), selected_trial_headline: aa?.source_model_id ?? null } });
      if (row.n_precision && row.n_precision !== "day") problems.push({ code: "non_day_date_excluded_by_current_n_policy", provider: provider.id, model: model.id, detail: { date: row.n_date, precision: row.n_precision } });
      if (row.n_precision === "day" && !row.n_eligible) problems.push({ code: "future_date_excluded", provider: provider.id, model: model.id, detail: row.n_date });
      if (dates.length > 1) problems.push({ code: "conflicting_upstream_dates", provider: provider.id, model: model.id, detail: dates });
      if (upstreamRecords.length && !dates.length) problems.push({ code: "upstream_date_missing", provider: provider.id, model: model.id });
      if (nDate && !row.n_precision) problems.push({ code: "invalid_upstream_date", provider: provider.id, model: model.id, detail: nDate });
      providerRows.push(row); rows.push(row);
    }
    const ranked = (field: "c_score" | "p_trial_score" | "n_date") => [...providerRows].sort((a, b) => compareReportRows(a, b, field, now));
    const cAll = ranked("c_score"), pAll = ranked("p_trial_score"), nAll = ranked("n_date");
    const c = cAll.filter(row => row.included_in_client_context), p = pAll.filter(row => row.included_in_client_context), n = nAll.filter(row => row.included_in_client_context);
    for (const [index, row] of cAll.entries()) row.c_source_order_position = index + 1;
    for (const [index, row] of pAll.entries()) row.p_trial_source_order_position = index + 1;
    for (const [index, row] of nAll.entries()) row.n_source_order_position = index + 1;
    for (const [index, row] of c.entries()) row.c_order_position = index + 1;
    for (const [index, row] of p.entries()) row.p_trial_order_position = index + 1;
    for (const [index, row] of n.entries()) row.n_order_position = index + 1;
    for (const index of [c, p, n]) if (new Set(index.map(row => row.request_model_id)).size !== effective.length || index.some(row => !effectiveIds.has(row.request_model_id))) throw new Error("Ranking changed available membership");
    providers.push({ id: provider.id, name: provider.name, selector_declared_visible: provider.show_in_selector ?? null, restricted_in_default_manager: provider.restricted_in_default_manager ?? null, catalog_status: provider.catalog_status ?? null, account_availability: "not_evaluated", refresh_status: result.status, refresh_reason: result.reason, latest_refreshed: fresh, listed_count: result.listed_model_ids.length, client_projected_count: result.models.length, effective_count: effective.length, diagnostic_count: providerRows.length, source_only_count: providerRows.filter(row => !row.included_in_client_context).length, fallback_count: result.fallback.models.length, upstream_found: providerRows.filter(row => row.upstream_record_found).length, canonical_known: providerRows.filter(row => row.canonical_id).length, client_c_known: providerRows.filter(row => row.included_in_client_context && row.c_score !== null).length, client_p_trial_known: providerRows.filter(row => row.included_in_client_context && row.p_trial_score !== null).length, client_n_known: providerRows.filter(row => row.included_in_client_context && row.n_eligible).length, c_known: providerRows.filter(row => row.c_score !== null).length, p_trial_known: providerRows.filter(row => row.p_trial_score !== null).length, n_known: providerRows.filter(row => row.n_eligible).length, c_order: c.map(row => row.request_model_id), p_trial_order: p.map(row => row.request_model_id), n_order: n.map(row => row.request_model_id), requests: result.requests, source: provider.source });
  }
  for (const [field, orderName] of [["c_score", "c_global_order_position"], ["p_trial_score", "p_trial_global_order_position"], ["n_date", "n_global_order_position"]] as const) {
    [...rows].sort((a, b) => compareReportRows(a, b, field, now)).forEach((row, index) => { row[orderName] = index + 1; });
  }
  const canonicalIds = new Set<string>(rows.map(row => row.canonical_id).filter(Boolean));
  const windowCoverage = [1, 2, 3, 7].map(days => {
    const dates = completeDays(now, days), union = new Set<string>(), sameSourceComplete = new Set<string>();
    const dayUnion = new Map<string, Set<string>>();
    const sourceCounts = Object.fromEntries(trialSources.map(source => {
      const observed = new Set<string>();
      for (const canonical of canonicalIds) {
        const values = shares.get(source)?.get(canonical);
        const observedDates = dates.filter(date => values?.has(date));
        if (!observedDates.length) continue;
        observed.add(canonical);
        if (popularityPolicy.weights[source]! > 0) {
          union.add(canonical);
          dayUnion.set(canonical, new Set([...(dayUnion.get(canonical) ?? []), ...observedDates]));
          if (observedDates.length === dates.length) sameSourceComplete.add(canonical);
        }
      }
      return [source, observed.size];
    }));
    return { days, start: dates[0], end: dates.at(-1), source_counts: sourceCounts, independent_models: union.size, provider_model_records: rows.filter(row => union.has(row.canonical_id)).length, every_day_any_source_models: [...dayUnion.values()].filter(values => values.size === dates.length).length, same_source_full_window_models: sameSourceComplete.size };
  });
  const issuesByCode = Object.fromEntries([...new Set(problems.map(p => p.code))].sort().map(code => [code, problems.filter(p => p.code === code).length]));
  const report = { schema_version: 1, evaluated_at: now, coginework: inventory.coginework, runtime: { bun: Bun.version }, implementation_sha256: implementationHashes, modelspage_worktree_dirty: new TextDecoder().decode(Bun.spawnSync(["git", "status", "--porcelain"]).stdout).trim().length > 0, modelspage_head: new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout).trim(), input_hashes: { inventory: sha256(await readFile(join(directory, "inputs/coginework-providers.json"))), refresh_index: sha256(await readFile(join(directory, "refresh/index.json"))), sources_index: sha256(await readFile(join(directory, "sources/index.json"))) }, upstream: reg.source, scope: "Every registered built-in Provider, including restricted/retired entries; client_context denotes source-defined protocol projection, not installed visibility or account eligibility; no inference, private settings, OAuth account catalogs or production writes", production_pipeline: { aa_adapter: "not_implemented", canonical_score_inheritance: "not_implemented", multisource_weighted_popularity: "not_implemented", data_for_this_report: "diagnostic_only_not_a_production_catalog" }, trial_popularity_method: { id: popularityPolicy.id, aggregation_status: "accepted_weighted_union", weights_status: popularityPolicy.weights_status, window_days: popularityPolicy.window_days, complete_utc_dates: activeDates, active_sources: trialSources, weights: popularityPolicy.weights, fallback_order: ["P", "C", "N", "existing_stable_order"], missing_policy: "Any observed source/day contributes with fixed global weights and full-window denominator; absent entries stay null and add no observed bonus; all missing means unknown; never per-model weight renormalization", interpretation: "Weighted observed token-heat evidence, not complete platform share, request count or deduplicated market usage" }, popularity_window_coverage: windowCoverage, summary: { provider_count: providers.length, latest_refreshed_providers: providers.filter(p => p.latest_refreshed).length, model_rows: rows.length, latest_refreshed_model_rows: rows.filter(r => r.latest_refreshed).length, client_context_model_rows: rows.filter(r => r.included_in_client_context).length, source_only_model_rows: rows.filter(r => !r.included_in_client_context).length, fallback_model_rows: rows.filter(r => r.inventory_basis === "packaged_fallback_not_latest").length, canonical_known: rows.filter(r => r.canonical_id).length, c_known: rows.filter(r => r.c_score !== null).length, p_trial_known: rows.filter(r => r.p_trial_score !== null).length, p_independent_models: new Set(rows.filter(r => r.p_trial_score !== null).map(r => r.canonical_id)).size, n_day_known: rows.filter(r => r.n_eligible).length, issues_by_code: issuesByCode }, sources, providers, source_associations: sourceEntries, models: rows, issues: problems };
  await mkdir(outDir, { recursive: true });
  await atomicWrite(join(outDir, "report.json"), stableStringify(report));
  await atomicWrite(join(outDir, "models.csv"), csvTable(rows, ["provider_id", "request_model_id", "display_name", "model_protocol", "inventory_basis", "included_in_client_context", "account_availability", "provider_selector_declared_visible", "provider_restricted_in_default_manager", "provider_catalog_status", "refresh_status", "modelsdev_provider", "canonical_id", "canonical_status", "c_score", "c_aa_slug", "c_index_version", "c_status", "c_alternatives", "c_configuration_policy", "c_order_position", "c_global_order_position", "p_trial_score", "p_trial_status", "p_sort_basis", "p_source_scores", "p_source_evidence", "p_observed_sources", "p_observed_source_weight", "p_observed_day_weight", "p_missing_source_days", "p_trial_order_position", "p_trial_global_order_position", "n_date", "n_precision", "n_eligible", "n_order_position", "n_global_order_position"]));
  await atomicWrite(join(outDir, "providers.csv"), csvTable(providers, ["id", "name", "selector_declared_visible", "restricted_in_default_manager", "catalog_status", "account_availability", "refresh_status", "refresh_reason", "listed_count", "client_projected_count", "effective_count", "diagnostic_count", "source_only_count", "fallback_count", "upstream_found", "canonical_known", "c_known", "p_trial_known", "n_known"]));
  await atomicWrite(join(outDir, "issues.csv"), csvTable(problems, ["code", "provider", "model", "model_id", "source", "status", "detail"]));
  await atomicWrite(join(outDir, "source-associations.csv"), csvTable(sourceEntries, ["source_id", "source_model_id", "source_slug", "display_name", "metric", "value", "index_version", "date", "window_label", "is_aggregate", "association"]));
  await atomicWrite(join(outDir, "popularity-window-coverage.json"), stableStringify({ evaluated_at: now, method: "any observed source/day union; distinct canonical IDs within the full Provider scope", windows: windowCoverage }));
  await atomicWrite(join(outDir, "index.html"), html(report));
  return report;
}

function html(report: Row) {
  const data = JSON.stringify(report).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CogineWork 全 Provider C/P/N 验证</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#18202a;font:14px/1.6 system-ui,sans-serif}main{padding:32px;max-width:1800px;margin:auto}h1{font-size:27px;margin:0 0 8px}h2{margin:28px 0 12px}.muted{color:#626e7e}.notice{background:#fff4d5;border:1px solid #e8cf8d;padding:14px;border-radius:8px;margin:16px 0}.cards{display:flex;gap:12px;flex-wrap:wrap}.card{background:white;border:1px solid #dce1e8;border-radius:8px;padding:14px 20px;min-width:145px}.card b{display:block;font-size:25px}.controls{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}select,input{padding:8px 10px;border:1px solid #bac4d1;border-radius:5px;background:white;font:inherit}input{min-width:260px}.wrap{overflow:auto;background:white;border:1px solid #dce1e8;border-radius:7px;max-height:65vh}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e7eaf0;vertical-align:top}th{position:sticky;top:0;background:#eef2f7;white-space:nowrap}td.id{max-width:340px;overflow-wrap:anywhere}a{color:#1c5fc4}.good{color:#147047}.bad{color:#a5481a}code{background:#eaf0f5;padding:1px 4px;border-radius:3px}details{background:white;padding:12px;margin-top:14px}footer{margin-top:28px;color:#626e7e}</style>
  <main><h1>CogineWork 全 Provider C/P/N 验证</h1><p class="muted" id="stamp"></p><div class="notice">这是本地验证结果。真实刷新、上游资料和随包回退分别标注；来源补录不能增加客户端可用成员；源码投影包含受限/退役 Provider，不等于安装版可见性或账户资格。C 使用 AA base-slug 主记录作参考，未统一 effort，也不代表 Provider 默认配置；P 的次序依次采用 P、C、N，再用既定稳定次序；兜底不产生热度事实。C 缺失时按日期兜底。P 按固定权重累加并集；缺失日/来源保留空值，不要求齐全。来源权重由下方版本化方法配置确定；尚未接入生产发布。没有推理调用、账户资格授予或生产发布。</div><div class="cards" id="cards"></div><p class="muted" id="weightSummary"></p>
  <h2>全部 Provider</h2><p><a href="providers.csv">下载 Provider CSV</a> · <a href="models.csv">下载全部模型与排名 CSV</a> · <a href="issues.csv">下载问题清单</a> · <a href="source-associations.csv">下载各来源完整身份关联</a> · <a href="report.json">完整 JSON</a></p><div class="wrap"><table><thead><tr><th>Provider</th><th>刷新状态</th><th>源目录 / 客户端</th><th>源码投影 / 来源补录</th><th>canonical</th><th>C 参考 / 全部资料行</th><th>P 试算 / 全部资料行</th><th>N 日期 / 全部资料行</th><th>状态说明</th></tr></thead><tbody id="providers"></tbody></table></div>
  <h2>P 的窗口覆盖（独立模型去重）</h2><p class="muted">按来源 UTC 日桶，截至上一日。窗口内任一来源有任一天记录即可纳入。</p><div class="wrap"><table><thead><tr><th>窗口</th><th>OpenRouter</th><th>Vercel</th><th>Go/Free</th><th>并集独立模型</th><th>Provider 模型记录</th></tr></thead><tbody id="windows"></tbody></table></div><h2>完整模型列表与排序</h2><div class="controls"><select id="provider"><option value="">所有 Provider</option></select><select id="mode"><option value="n">N / 日期顺序</option><option value="c">C / AA 主记录参考得分</option><option value="p">P / 权重并集</option></select><select id="basis"><option value="">全部诊断记录</option><option value="client">源码协议投影（含回退）</option><option value="source">仅来源补录</option><option value="live">仅 API 实时目录</option><option value="fallback">仅随包回退</option></select><input id="search" placeholder="搜索模型 ID、名称、canonical"><select id="limit"><option>200</option><option>1000</option><option value="999999">全部</option></select><span id="count"></span></div><div class="wrap"><table><thead><tr><th>顺序</th><th>Provider</th><th>请求模型 ID</th><th>名称 / canonical</th><th>目录依据</th><th>C / AA</th><th>P 试算 / 来源分</th><th>N / 精度</th></tr></thead><tbody id="models"></tbody></table></div>
  <h2>来源与未完成事项</h2><div id="sources"></div><details><summary>问题分类统计</summary><pre id="issues"></pre></details><details><summary>P 试算方法与窗口</summary><pre id="method"></pre></details><footer>请求 ID 保持原样；所有模型都参与输出，包括未关联、未知、刷新失败和没有公开目录的 Provider。原始网络证据保存在本地忽略目录，未提交到公共仓库。</footer></main>
  <script id="data" type="application/json">${data}</script><script>
  const d=JSON.parse(document.getElementById('data').textContent),el=id=>document.getElementById(id),esc=x=>String(x??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),fmt=x=>x===null||x===undefined?'未知':Number(x).toFixed(3);
  el('stamp').textContent='验证时间 '+d.evaluated_at+' · CogineWork '+d.coginework.head+' · 上游 '+d.upstream.commit;
  const s=d.summary;el('cards').innerHTML=[['Provider',s.provider_count],['真实刷新 Provider',s.latest_refreshed_providers],['模型记录',s.model_rows],['C 有分数',s.c_known],['P 并集模型',s.p_independent_models],['N 日精度可用',s.n_day_known]].map(([label,v])=>'<div class="card">'+esc(label)+'<b>'+esc(v)+'</b></div>').join('');
  el('weightSummary').textContent='P 权重 '+Object.entries(d.trial_popularity_method.weights).map(([source,weight])=>source+' '+(weight*100)+'%').join(' / ')+' · 窗口 '+d.trial_popularity_method.window_days+' 天 · 任一来源/任一天记录可贡献';
  el('providers').innerHTML=d.providers.map(p=>'<tr><td>'+esc(p.name)+(p.restricted_in_default_manager?' · 受限':p.catalog_status==='retired'?' · 已退役':'')+'<br><code>'+esc(p.id)+'</code></td><td class="'+(p.latest_refreshed?'good':'bad')+'">'+esc(p.refresh_status)+'</td><td>'+p.listed_count+' / '+p.client_projected_count+'</td><td>'+p.effective_count+' / '+p.source_only_count+'</td><td>'+p.canonical_known+'</td><td>'+p.c_known+'</td><td>'+p.p_trial_known+'</td><td>'+p.n_known+'</td><td>'+esc(p.refresh_reason)+'</td></tr>').join('');
  el('windows').innerHTML=d.popularity_window_coverage.map(w=>'<tr><td>'+w.days+' 天<br><span class="muted">'+esc(w.start)+' ~ '+esc(w.end)+'</span></td><td>'+w.source_counts.openrouter+'</td><td>'+w.source_counts['vercel-ai-gateway']+'</td><td>'+w.source_counts['opencode-go-free']+'</td><td><b>'+w.independent_models+'</b></td><td>'+w.provider_model_records+'</td></tr>').join('');
  d.providers.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;el('provider').append(o)});
  function render(){const pid=el('provider').value,mode=el('mode').value,basis=el('basis').value,q=el('search').value.toLowerCase(),lim=Number(el('limit').value);const rows=d.models.filter(r=>(!pid||r.provider_id===pid)&&(!basis||(basis==='client'?r.included_in_client_context:basis==='source'?!r.included_in_client_context:basis==='live'?r.latest_refreshed:r.inventory_basis==='packaged_fallback_not_latest'))&&(!q||[r.request_model_id,r.display_name,r.canonical_id].join(' ').toLowerCase().includes(q))).sort((a,b)=>a[mode==='p'?'p_trial_global_order_position':mode+'_global_order_position']-b[mode==='p'?'p_trial_global_order_position':mode+'_global_order_position']);el('count').textContent=rows.length+' 条';el('models').innerHTML=rows.slice(0,lim).map(r=>'<tr><td>'+r[pid?(mode==='p'?'p_trial_source_order_position':mode+'_source_order_position'):(mode==='p'?'p_trial_global_order_position':mode+'_global_order_position')]+'</td><td>'+esc(r.provider_name)+'</td><td class="id"><code>'+esc(r.request_model_id)+'</code></td><td>'+esc(r.display_name)+'<br><span class="muted">'+esc(r.canonical_id)+'</span></td><td class="'+(r.latest_refreshed?'good':'bad')+'">'+esc(({live_catalog_client_projection:'实时 / 客户端投影',live_source_catalog_excluded_by_client:'实时 / 客户端未接纳',latest_upstream_reference_not_api_membership:'最新上游资料 / 非账户成员',packaged_fallback_not_latest:'随包回退'})[r.inventory_basis]||r.inventory_basis)+'</td><td>'+fmt(r.c_score)+'<br>'+esc(r.c_aa_name||r.c_status)+(r.c_alternatives.length>1?'<details><summary>全部配置 '+r.c_alternatives.length+'</summary>'+r.c_alternatives.map(a=>esc(a.name)+' · '+fmt(a.score)+'<br>').join('')+'</details>':'')+'</td><td>'+fmt(r.p_trial_score)+(r.p_trial_score===null?' · '+esc(({capability_fallback:'按 C 兜底',release_fallback:'按 N 兜底',stable_default_order:'默认次序'})[r.p_sort_basis]):'')+'<br><span class="muted">'+esc(JSON.stringify(r.p_source_scores))+'</span><br>'+r.p_observed_sources+' 个来源 · 加权日覆盖 '+fmt(r.p_observed_day_weight*100)+'%</td><td>'+esc(r.n_date)+'<br>'+esc(r.n_precision)+(r.n_eligible?'':' / 不参与日精度 N')+'</td></tr>').join('')};['provider','mode','basis','limit'].forEach(id=>el(id).onchange=render);el('search').oninput=render;render();
  el('sources').innerHTML=d.sources.map(s=>'<details><summary>'+esc(s.source_id)+' · '+esc(s.status)+' · '+s.entries+' 条</summary><p>'+esc(s.scope)+'</p><pre>'+esc(JSON.stringify({window:s.window,usage:s.usage,issues:s.issues},null,2))+'</pre></details>').join('');el('issues').textContent=JSON.stringify(s.issues_by_code,null,2);el('method').textContent=JSON.stringify(d.trial_popularity_method,null,2);
  </script></html>`;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { input: { type: "string" }, out: { type: "string" }, now: { type: "string" }, "p-days": { type: "string" } } });
  const output = resolve(values.out ?? "dist/full-validation");
  const report = await generateReport(resolve(values.input ?? ".modelspage/full-validation"), output, values.now ?? new Date().toISOString(), values["p-days"] === undefined ? undefined : Number(values["p-days"]));
  console.log(JSON.stringify({ output, summary: report.summary, upstream: { commit: report.upstream.commit, parse_status: report.upstream.parse_status, counts: report.upstream.counts }, trial: report.trial_popularity_method }));
}
