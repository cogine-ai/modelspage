import { trustedRelease } from "./projection.js";
import { validateBundle } from "./schema.js";
import { identityKey, type Bundle, type Field } from "./types.js";

/** Initial production release needs usable evidence in all three modes. Later corrections may remove it. */
export function assertInitialCpnReadiness(input: Bundle) {
  const bundle = validateBundle(input);
  if (bundle.fixture) throw new Error("Synthetic fixture releases cannot satisfy initial production readiness");
  const sources = new Map(bundle.source_revisions.map(source => [source.id, source]));
  const permitted = (sourceId: string) => {
    const source = sources.get(sourceId);
    return source?.usage.redistribution === "allowed";
  };
  const conflicts = new Set(bundle.mappings.filter(mapping => mapping.status !== "approved").flatMap(mapping => mapping.fields.map(field => `${identityKey(mapping.from)}:${field}`)));
  const applicable = (model: Bundle["facts"][number], field: Field) => !conflicts.has(`${identityKey(model.identity)}:${field}`);
  const counts = { capability: 0, popularity: 0, newest: 0 };
  for (const model of bundle.facts) {
    const capability = model.capability;
    if (applicable(model, "capability") && capability.state === "known" && permitted(capability.source_id)) {
      const profile = bundle.metric_profiles.find(profile => profile.id === capability.value.profile_id);
      if (profile?.usage.redistribution === "allowed") counts.capability++;
    }
    const popularity = model.popularity;
    if (applicable(model, "popularity") && popularity.state === "known" && popularity.value.ranking_eligible && permitted(popularity.source_id) && sources.get(popularity.source_id)?.complete) counts.popularity++;
    const newest = model.release;
    if (applicable(model, "release") && newest.state === "known" && permitted(newest.source_id) && trustedRelease(newest, bundle.published_at)) counts.newest++;
  }
  const missing = Object.entries(counts).filter(([, count]) => count === 0).map(([mode]) => mode);
  if (missing.length) throw new Error(`Initial production requires usable licensed C/P/N evidence; missing: ${missing.join(", ")}`);
  return counts;
}
