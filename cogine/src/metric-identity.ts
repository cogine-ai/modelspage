import type { Identity } from "./types.js";

/** Public upstream metadata. These rows never grant client membership or a route. */
export type MetricIdentityRow = {
  provider_id: string;
  id: string;
  name?: string;
  canonical_id?: string | null;
  weights?: readonly { url: string; label?: string }[];
  [key: string]: unknown;
};
export type MetricIdentityLink = {
  status: "matched" | "unmatched" | "ambiguous";
  canonical_id: string | null;
  method: string;
  candidates: string[];
};
export type MetricIdentityRegistry = {
  records: MetricIdentityRow[];
  canonicals: Map<string, MetricIdentityRow[]>;
  byProviderId: Map<string, MetricIdentityRow[]>;
  slugKeys: Map<string, Set<string>>;
  hfKeys: Map<string, Set<string>>;
};
export type SourceMetricEntry = {
  source_model_id: string;
  source_slug?: string;
  display_name?: string;
  is_aggregate?: boolean;
  associations?: { openrouter_api_id?: string | null; huggingface_url?: string | null };
};
export type SourceIdentityCatalogs = {
  openrouterCatalogs?: readonly { data?: readonly { id?: string; canonical_slug?: string }[] }[];
  vercelCatalog?: { data?: readonly { id?: string; name?: string }[] } | null;
};

export const metricPairKey = (provider: string, id: string) => JSON.stringify([provider, id]);
export const normalizeMetricKey = (value: string) => (value.normalize("NFKC").toLowerCase().match(/[a-z]+|[0-9]+/g) ?? []).join("-");
const add = (index: Map<string, Set<string>>, key: string | undefined, value: string) => {
  if (key) index.set(key, new Set([...(index.get(key) ?? []), value]));
};
export function metricIdentityLink(candidates: Iterable<string>, method: string): MetricIdentityLink {
  const values = [...new Set(candidates)].sort();
  return { status: values.length === 1 ? "matched" : values.length ? "ambiguous" : "unmatched", canonical_id: values.length === 1 ? values[0]! : null, method, candidates: values };
}

export function canonicalKeys(canonical: string): string[] {
  const short = canonical.slice(canonical.indexOf("/") + 1);
  const keys = [normalizeMetricKey(short)];
  // The source uses both explicit Claude family/version orders.
  const claude = /^claude-(sonnet|opus|haiku)-(.+)$/.exec(short);
  if (claude) keys.push(normalizeMetricKey(`claude-${claude[2]}-${claude[1]}`));
  return keys;
}
export function weightsUrl(value: string): string {
  try { const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/$/, "")}`; }
  catch { return value; }
}
export function aaVariantBase(slug: string, displayName: string): string | null {
  const configuration = /\(([^()]*)\)$/.exec(displayName)?.[1];
  if (!configuration || !/^(?:(?:Non-reasoning|Reasoning|Minimal|Low|Medium|High|Xhigh|Max)(?:,\s*(?:Low|High|Default Fallback))?)$/i.test(configuration)) return null;
  const match = /-(non-reasoning-low-effort|non-reasoning|minimal|medium|xhigh|reasoning|adaptive|thinking|low|high|max)$/.exec(slug);
  return match ? slug.slice(0, -match[0].length) : null;
}

export function buildMetricIdentityRegistry(rows: readonly MetricIdentityRow[]): MetricIdentityRegistry {
  const records = [...rows], canonicals = new Map<string, MetricIdentityRow[]>(), byProviderId = new Map<string, MetricIdentityRow[]>();
  const slugKeys = new Map<string, Set<string>>(), hfKeys = new Map<string, Set<string>>();
  for (const row of records) {
    const key = metricPairKey(row.provider_id, row.id);
    byProviderId.set(key, [...(byProviderId.get(key) ?? []), row]);
    if (!row.canonical_id) continue;
    canonicals.set(row.canonical_id, [...(canonicals.get(row.canonical_id) ?? []), row]);
    for (const slug of canonicalKeys(row.canonical_id)) add(slugKeys, slug, row.canonical_id);
    for (const weight of row.weights ?? []) add(hfKeys, weightsUrl(weight.url), row.canonical_id);
  }
  return { records, canonicals, byProviderId, slugKeys, hfKeys };
}
export function exactMetricCanonical(registry: MetricIdentityRegistry, providers: readonly string[], id: string): MetricIdentityLink {
  return metricIdentityLink(providers.flatMap(provider => (registry.byProviderId.get(metricPairKey(provider, id)) ?? []).flatMap(row => row.canonical_id ? [row.canonical_id] : [])), "exact_upstream_provider_record");
}

/** Source adapters own these namespaces. Unknown sources never fall into AA matching. */
export function createSourceIdentityResolver(registry: MetricIdentityRegistry, catalogs: SourceIdentityCatalogs = {}) {
  const orAliases = new Map<string, Set<string>>(), slugsById = new Map<string, Set<string>>(), orConflicts = new Map<string, MetricIdentityLink>();
  const orRows = (catalogs.openrouterCatalogs ?? []).flatMap(catalog => catalog.data ?? []);
  for (const row of orRows) if (row.id && row.canonical_slug) add(slugsById, row.id, row.canonical_slug);
  for (const [id, slugs] of slugsById) if (slugs.size > 1) {
    const identities = [...slugs].map(slug => exactMetricCanonical(registry, ["openrouter"], slug));
    const current = exactMetricCanonical(registry, ["openrouter"], id);
    const candidates = [...new Set([current, ...identities].flatMap(link => link.candidates))].sort();
    if (candidates.length === 1 && identities.every(link => link.canonical_id === candidates[0])) continue;
    const conflict: MetricIdentityLink = { status: "ambiguous", canonical_id: null, method: "openrouter_catalog_identity_changed", candidates };
    for (const key of [id, ...slugs]) orConflicts.set(key, conflict);
  }
  for (const row of orRows) {
    if (!row.id) continue;
    const canonical = exactMetricCanonical(registry, ["openrouter"], row.id);
    if (!canonical.canonical_id) continue;
    add(orAliases, row.id, canonical.canonical_id);
    if (row.canonical_slug) add(orAliases, row.canonical_slug, canonical.canonical_id);
  }
  const vercelNames = new Map<string, Set<string>>();
  for (const row of catalogs.vercelCatalog?.data ?? []) {
    if (!row.id || !row.name) continue;
    const found = exactMetricCanonical(registry, ["vercel"], row.id);
    if (found.canonical_id) add(vercelNames, row.name, found.canonical_id);
  }
  for (const row of registry.records) if (row.provider_id === "vercel" && row.canonical_id) add(vercelNames, row.name, row.canonical_id);
  return (sourceId: string, entry: SourceMetricEntry): MetricIdentityLink => {
    if (entry.is_aggregate || entry.source_model_id === "other" || entry.source_model_id === "Other") return metricIdentityLink([], "aggregate_other_is_not_a_model");
    if (sourceId === "vercel-ai-gateway") return metricIdentityLink(vercelNames.get(entry.source_model_id) ?? [], "vercel_source_name_to_its_catalog_id");
    if (sourceId === "opencode-go-free") return exactMetricCanonical(registry, ["opencode-go", "opencode"], entry.source_model_id);
    if (sourceId === "openrouter") {
      const conflict = orConflicts.get(entry.source_model_id);
      if (conflict) return conflict;
      const bridged = orAliases.get(entry.source_model_id);
      return bridged?.size ? metricIdentityLink(bridged, "openrouter_canonical_slug_bridge") : exactMetricCanonical(registry, ["openrouter"], entry.source_model_id);
    }
    if (sourceId !== "artificial-analysis") return metricIdentityLink([], "unsupported_metric_source");
    const associations = entry.associations ?? {};
    const declared: MetricIdentityLink[] = [];
    if (associations.openrouter_api_id) {
      const found = exactMetricCanonical(registry, ["openrouter"], associations.openrouter_api_id);
      if (found.status !== "unmatched") declared.push({ ...found, method: "aa_declared_openrouter_api_id" });
    }
    if (associations.huggingface_url) {
      const found = metricIdentityLink(registry.hfKeys.get(weightsUrl(associations.huggingface_url)) ?? [], "aa_declared_weights_url");
      if (found.status !== "unmatched") declared.push(found);
    }
    if (declared.length) {
      const combined = metricIdentityLink(declared.flatMap(link => link.candidates), "aa_declared_identity_bridges");
      if (combined.status === "ambiguous") return { ...combined, method: "aa_declared_identity_conflict" };
      return declared.length === 1 ? declared[0]! : combined;
    }
    const direct = metricIdentityLink(registry.slugKeys.get(normalizeMetricKey(entry.source_slug ?? "")) ?? [], "aa_exact_model_slug_with_claude_family_order_alias");
    if (direct.status !== "unmatched") return direct;
    const base = aaVariantBase(entry.source_slug ?? "", entry.display_name ?? "");
    return base ? metricIdentityLink(registry.slugKeys.get(normalizeMetricKey(base)) ?? [], "aa_configuration_suffix_candidate_not_runtime_verification") : direct;
  };
}

export type AaHeadlineEntry = { source_model_id: string; source_slug?: string; value?: unknown; index_version?: unknown };
/** Preserve the named headline when unique, never select the highest score. */
export function selectAaHeadline<T extends AaHeadlineEntry>(canonicalId: string, entries: readonly T[], indexVersions?: Iterable<unknown>) {
  const scored = (entry: T) => entry.value !== null && entry.value !== undefined && entry.value !== "" && Number.isFinite(Number(entry.value));
  const exact = entries.filter(entry => canonicalKeys(canonicalId).includes(normalizeMetricKey(entry.source_slug ?? "")));
  const configurations = [...new Map(entries.filter(scored).map(entry => [entry.source_model_id, entry])).values()];
  const candidates = [...new Map((exact.length ? exact : entries).filter(scored).map(entry => [entry.source_model_id, entry])).values()];
  const versions = new Set(indexVersions ?? entries.filter(scored).map(entry => entry.index_version));
  const selected = candidates.length === 1 && versions.size === 1 && !versions.has(undefined) ? candidates[0]! : null;
  return { selected, candidates, configurations };
}

/** Return only already supplied identities, retaining their full public scope. */
export function canonicalMetricTargets<T extends { identity: Identity; canonical_id?: string }>(existing: readonly T[], canonicalId: string): T[] {
  return existing.filter(row => row.canonical_id === canonicalId);
}
