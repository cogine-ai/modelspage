import { applyCorrections } from "./corrections.js";
import { validCalendarDate } from "./schema.js";
import { identityKey, unknown, type Bundle, type Fact, type Field, type Identity, type ModelFacts, type ReleaseDate } from "./types.js";

export type MatchStatus = "matched" | "unmatched" | "ambiguous" | "conflict";
export type AvailableModel = { identity: Identity; display_name: string; free?: boolean };
export type ProjectedModel<T extends AvailableModel = AvailableModel> = T & { public_facts: Pick<ModelFacts, "release" | "capability" | "popularity">; match_status: Record<Field, MatchStatus> };
export type ProjectionOptions = { profile_id?: string; popularity_source_id?: string; provider_order?: string[]; now?: string };

/** IDs, case, punctuation and every scope dimension are significant. Names are never keys. */
export function matchFacts(identity: Identity, bundle: Bundle, field: Field): { status: MatchStatus; fact: Fact<any> } {
  return createMatcher(bundle)(identity, field);
}
function createMatcher(bundle: Bundle) {
  const models = applyCorrections(bundle.facts, bundle.corrections);
  const byIdentity = new Map<string, ModelFacts[]>();
  for (const model of models) { const key = identityKey(model.identity); byIdentity.set(key, [...(byIdentity.get(key) ?? []), model]); }
  const mappings = new Map<string, Bundle["mappings"]>();
  for (const mapping of bundle.mappings) { const key = identityKey(mapping.from); mappings.set(key, [...(mappings.get(key) ?? []), mapping]); }
  return (identity: Identity, field: Field): { status: MatchStatus; fact: Fact<any> } => {
  const key = identityKey(identity);
  const relevant = (mappings.get(key) ?? []).filter(m => m.fields.includes(field));
  if (relevant.some(m => m.status === "conflict" || m.status === "withdrawn")) return { status: "conflict", fact: { state: "conflict", reason: "Reviewed identity conflict or withdrawn association" } };
  const exact = byIdentity.get(key) ?? [];
  if (exact.length > 1) return { status: "ambiguous", fact: unknown("Multiple exact public identities") };
  if (exact.length === 1) {
    const fact = exact[0]![field];
    return { status: fact.state === "conflict" ? "conflict" : "matched", fact };
  }
  const keys = [...new Set(relevant.filter(m => m.status === "approved").map(m => identityKey(m.to)))];
  if (keys.length > 1) return { status: "ambiguous", fact: unknown("Multiple reviewed association targets; no best-score selection") };
  if (keys.length === 1) {
    const candidates = byIdentity.get(keys[0]!) ?? [];
    if (candidates.length === 1) {
      const fact = candidates[0]![field];
      return { status: fact.state === "conflict" ? "conflict" : "matched", fact };
    }
  }
  return { status: "unmatched", fact: unknown("No exact identity or reviewed field-specific association") };
  };
}

export function trustedRelease(fact: Fact<ReleaseDate>, now: string): string | undefined {
  if (fact.state !== "known") return;
  const value = fact.value;
  if (value.precision !== "day" || !value.verified || !value.version_specific || !validCalendarDate(value.date, "day") || value.date > now.slice(0, 10)) return;
  return value.date;
}
function compareAtom(a: number | string, b: number | string): number { return a < b ? -1 : a > b ? 1 : 0; }
function compareTuple(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < a.length; i++) { const delta = compareAtom(a[i]!, b[i]!); if (delta) return delta; }
  return 0;
}

/** Pure projection over the host's complete available context. Search/free filtering happens later. */
export function project<T extends AvailableModel>(available: readonly T[], bundle: Bundle, options: ProjectionOptions = {}) {
  const now = options.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) throw new Error("Invalid projection clock");
  const keys = available.map(x => identityKey(x.identity));
  if (new Set(keys).size !== keys.length) throw new Error("Available context has duplicate exact identities");
  const providerOrder = options.provider_order ?? [...new Set(available.map(x => x.identity.provider))];
  const providerRank = new Map(providerOrder.map((provider, i) => [provider, i]));
  const sourceById = new Map(bundle.source_revisions.map(source => [source.id, source]));
  const profile = bundle.metric_profiles.find(x => x.id === options.profile_id);
  if (options.profile_id && !profile) throw new Error("Selected metric profile is absent");
  if (profile && profile.usage.redistribution !== "allowed") throw new Error("Selected metric profile is not licensed for public distribution");
  const match = createMatcher(bundle);
  const models: ProjectedModel<T>[] = available.map(model => {
    const release = match(model.identity, "release");
    const capability = match(model.identity, "capability");
    const popularity = match(model.identity, "popularity");
    return { ...model, public_facts: { release: release.fact, capability: capability.fact, popularity: popularity.fact }, match_status: { release: release.status, capability: capability.status, popularity: popularity.status } };
  });
  const dateKey = (model: ProjectedModel) => { const date = trustedRelease(model.public_facts.release, now); return date ? -Date.parse(date) : Number.POSITIVE_INFINITY; };
  const tieKey = (model: ProjectedModel): (number | string)[] => [dateKey(model), providerRank.get(model.identity.provider) ?? Number.MAX_SAFE_INTEGER, identityKey(model.identity)];
  const capabilityKey = (model: ProjectedModel): (number | string)[] => {
    const fact = model.public_facts.capability;
    const usable = !!profile && fact.state === "known" && fact.value.profile_id === profile.id && fact.source_id === profile.source_id && fact.value.model_snapshot === profile.model_snapshot && fact.value.inference_config === profile.inference_config && sourceById.get(fact.source_id)?.usage.redistribution === "allowed";
    return [usable ? 0 : 1, usable && fact.state === "known" ? fact.value.score * (profile!.direction === "higher" ? -1 : 1) : 0, ...tieKey(model)];
  };
  const popularityKey = (model: ProjectedModel): (number | string)[] => {
    const fact = model.public_facts.popularity;
    const usable = !!options.popularity_source_id && fact.state === "known" && fact.value.ranking_eligible && fact.value.source_id === options.popularity_source_id && fact.source_id === options.popularity_source_id && sourceById.get(fact.source_id)?.usage.redistribution === "allowed";
    return [usable ? 0 : 1, usable && fact.state === "known" ? fact.value.position : 0, ...tieKey(model)];
  };
  const sortBy = (key: (model: ProjectedModel<T>) => (number | string)[]) => models.map(model => ({ model, key: key(model) })).sort((a, b) => compareTuple(a.key, b.key)).map(x => x.model);
  const capability = sortBy(capabilityKey);
  const popularity = sortBy(popularityKey);
  const newest = sortBy(model => [dateKey(model), providerRank.get(model.identity.provider) ?? Number.MAX_SAFE_INTEGER, keys.indexOf(identityKey(model.identity)), identityKey(model.identity)]);
  const capabilityEvidence = models.some(model => capabilityKey(model)[0] === 0);
  const popularityEvidence = models.some(model => popularityKey(model)[0] === 0);
  return {
    capability, popularity, newest,
    explanations: {
      capability: capabilityEvidence ? `能力优先；profile=${profile!.id}；${profile!.name}；${profile!.task}；${profile!.evaluation_conditions}` : "能力证据未知：没有已选且合法、可比较的 profile 证据。使用可信日期、Provider 展示次序、精确身份兜底；兜底不是能力结论。",
      popularity: popularityEvidence ? `热度优先；source=${options.popularity_source_id}；仅该来源快照的明确映射顺序；不是全市场用户数。` : "热度证据未知：没有可用的同源、逐项覆盖明确的热度顺序。使用可信日期、Provider 展示次序、精确身份兜底；未上榜不等于零。",
      newest: "按来源提供的模型发布日期（日精度）降序；models.dev 日期沿用上游维护结果。未知、未来及非日精度日期置后，再按 Provider 展示次序、原目录位置、精确身份。",
    },
  };
}
export function filterIndex<T extends AvailableModel>(index: readonly T[], options: { query?: string; free_only?: boolean }): T[] {
  const query = options.query?.toLocaleLowerCase();
  return index.filter(model => (!options.free_only || model.free === true) && (!query || model.display_name.toLocaleLowerCase().includes(query) || model.identity.request_model_id.toLocaleLowerCase().includes(query)));
}
