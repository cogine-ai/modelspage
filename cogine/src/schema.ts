import { z } from "zod";
import { identityKey, type Bundle, type Manifest } from "./types.js";
import { stableStringify } from "./integrity.js";

const text = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const scopeSchema = z.object({ route: text, region: text, plan: text, protocol: text }).strict();
export const identitySchema = z.object({ provider: text, request_model_id: text, scope: scopeSchema }).strict();
export const fieldSchema = z.enum(["release", "capability", "popularity"]);
export const usageSchema = z.object({ collection: z.enum(["allowed", "unverified", "disabled"]), redistribution: z.enum(["allowed", "unverified", "disabled"]), evidence: text }).strict();
export function validCalendarDate(date: string, precision: "day" | "month" | "year"): boolean {
  if (precision === "year") return /^\d{4}$/.test(date) && Number(date) > 0;
  if (precision === "month") return /^\d{4}-(0[1-9]|1[0-2])$/.test(date) && Number(date.slice(0, 4)) > 0;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number(date.slice(0, 4)) > 0 && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}
export const releaseValueSchema = z.object({ date: text, precision: z.enum(["day", "month", "year"]), verified: z.boolean(), version_specific: z.boolean() }).strict().refine(x => validCalendarDate(x.date, x.precision), "Date must preserve its actual calendar precision");
export const capabilityValueSchema = z.object({ profile_id: text, score: z.number().finite(), model_snapshot: text, inference_config: text }).strict();
export const popularityValueSchema = z.object({ source_id: text, source_model_id: text, position: z.number().int().positive(), ranking_eligible: z.boolean() }).strict();
export function factSchema<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("known"), value, source_id: text, retrieved_at: timestamp, data_as_of: timestamp.nullable(), evidence: text }).strict(),
    z.object({ state: z.literal("unknown"), reason: text }).strict(),
    z.object({ state: z.literal("withdrawn"), reason: text, correction_id: text }).strict(),
    z.object({ state: z.literal("conflict"), reason: text }).strict(),
  ]);
}
export const releaseFactSchema = factSchema(releaseValueSchema);
export const capabilityFactSchema = factSchema(capabilityValueSchema);
export const popularityFactSchema = factSchema(popularityValueSchema);
export const modelFactsSchema = z.object({ identity: identitySchema, display_name: text, canonical_id: text.optional(), release: releaseFactSchema, capability: capabilityFactSchema, popularity: popularityFactSchema }).strict();
export const sourceRevisionSchema = z.object({ id: text, status: z.enum(["success", "not_modified", "failed", "partial", "disabled"]), code_commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), url: z.string().url().optional(), retrieved_at: timestamp.nullable(), data_as_of: timestamp.nullable(), sha256: hash.optional(), window: z.object({ start: timestamp.nullable(), end: timestamp.nullable() }).strict(), usage: usageSchema, complete: z.boolean(), error: text.optional() }).strict();
export const metricProfileSchema = z.object({ id: text, source_id: text, name: text, metric: text, method_version: text, direction: z.enum(["higher", "lower"]), task: text, model_snapshot: text, inference_config: text, evaluation_conditions: text, usage: usageSchema }).strict();
export const mappingSchema = z.object({ id: text, from: identitySchema, to: identitySchema, fields: z.array(fieldSchema).min(1), canonical_id: text.optional(), evidence: text, reviewed_by: text, reviewed_at: timestamp, status: z.enum(["approved", "conflict", "withdrawn"]) }).strict();
export const correctionSchema = z.object({ id: text, identity: identitySchema, field: fieldSchema, action: z.enum(["replace", "withdraw", "conflict"]), value: z.unknown().optional(), reason: text, evidence: text, reviewed_by: text, reviewed_at: timestamp, sequence: z.number().int().positive() }).strict().superRefine((x, ctx) => {
  if (x.action === "replace") {
    const schema = { release: releaseFactSchema, capability: capabilityFactSchema, popularity: popularityFactSchema }[x.field];
    const result = schema.safeParse(x.value);
    if (!result.success || result.data?.state !== "known") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Replacement must be a known field fact with provenance" });
  } else if (x.value !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Only replacements carry a value" });
});
export const compatibilitySchema = z.object({ projection: z.literal(1), min_consumer_version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict();
export const bundleSchema = z.object({
  schema_version: z.literal(1), revision: hash, builder_version: text, publication_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), published_at: timestamp,
  source_revisions: z.array(sourceRevisionSchema), metric_profiles: z.array(metricProfileSchema), attribution: z.array(z.object({ source_id: text, license: text, url: z.string().url(), text }).strict()), module_compatibility: compatibilitySchema,
  facts: z.array(modelFactsSchema), mappings: z.array(mappingSchema), corrections: z.array(correctionSchema), fixture: z.boolean(),
}).strict();
export const manifestSchema = z.object({ schema_version: z.literal(1), revision: hash, publication_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), published_at: timestamp, objects: z.object({ catalog: z.object({ path: z.string().regex(/^v1\/revisions\/[a-f0-9]{64}\/catalog\.json$/), sha256: hash, size: z.number().int().positive().max(100_000_000) }).strict() }).strict(), module_compatibility: compatibilitySchema, fixture: z.boolean() }).strict();
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`); }
export function validateBundle(input: unknown): Bundle {
  const bundle = bundleSchema.parse(input) as Bundle;
  unique(bundle.facts.map(x => identityKey(x.identity)), "fact identity");
  unique(bundle.source_revisions.map(x => x.id), "source id");
  unique(bundle.metric_profiles.map(x => x.id), "profile id");
  unique(bundle.mappings.map(x => x.id), "mapping id");
  unique(bundle.corrections.map(x => x.id), "correction id");
  unique(bundle.corrections.map(x => `${identityKey(x.identity)}:${x.field}:${x.sequence}`), "correction sequence for a field");
  const sources = new Map(bundle.source_revisions.map(x => [x.id, x]));
  const profiles = new Map(bundle.metric_profiles.map(x => [x.id, x]));
  for (const profile of bundle.metric_profiles) if (!sources.has(profile.source_id)) throw new Error(`Profile references missing source: ${profile.id}`);
  for (const model of bundle.facts) {
    for (const field of ["release", "capability", "popularity"] as const) {
      const fact = model[field];
      if (fact.state === "known" && !sources.has(fact.source_id)) throw new Error(`Missing field source: ${fact.source_id}`);
      if (fact.state === "withdrawn" && !bundle.corrections.some(c => c.id === fact.correction_id && c.action === "withdraw" && c.field === field && identityKey(c.identity) === identityKey(model.identity))) throw new Error("Withdrawal requires matching correction record");
    }
    if (model.capability.state === "known") {
      const { value, source_id } = model.capability;
      const profile = profiles.get(value.profile_id);
      if (!profile || profile.source_id !== source_id || value.model_snapshot !== profile.model_snapshot || value.inference_config !== profile.inference_config) throw new Error("Capability requires exact profile source, snapshot and inference configuration");
    }
    if (model.popularity.state === "known" && model.popularity.source_id !== model.popularity.value.source_id) throw new Error("Popularity source mismatch");
  }
  const effectiveCorrections = new Map<string, Bundle["corrections"][number]>();
  for (const correction of bundle.corrections) {
    const key = `${identityKey(correction.identity)}:${correction.field}`;
    if ((effectiveCorrections.get(key)?.sequence ?? 0) < correction.sequence) effectiveCorrections.set(key, correction);
  }
  const factsByIdentity = new Map(bundle.facts.map(model => [identityKey(model.identity), model]));
  for (const correction of effectiveCorrections.values()) {
    const fact = factsByIdentity.get(identityKey(correction.identity))?.[correction.field];
    const expected = correction.action === "replace" ? correction.value : correction.action === "withdraw" ? { state: "withdrawn", correction_id: correction.id, reason: correction.reason } : { state: "conflict", reason: correction.reason };
    if (stableStringify(fact) !== stableStringify(expected)) throw new Error("Catalog field must reflect its latest reviewed correction");
  }
  return bundle;
}
export function validateManifest(input: unknown): Manifest {
  const manifest = manifestSchema.parse(input) as Manifest;
  if (manifest.objects.catalog.path !== `v1/revisions/${manifest.revision}/catalog.json`) throw new Error("Manifest revision/path mismatch");
  return manifest;
}
