import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { bundleSchema, capabilityFactSchema, identitySchema, metricProfileSchema, popularityFactSchema, releaseFactSchema, sourceRevisionSchema } from "../src/schema.js";
import { trustedRelease } from "../src/projection.js";
import { stableStringify } from "../src/integrity.js";
import type { WebRankingDataset } from "./data.js";

const text = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rankingDefaults = bundleSchema.shape.ranking_defaults.unwrap();
const orderSchema = z.object({ capability: z.array(text), popularity: z.array(text), newest: z.array(text) }).strict();

export const webRankingModelSchema = z.object({
  id: text,
  name: text,
  lab_id: text,
  href: z.string().regex(/^\/models\/[^?#]+\/$/),
  providers: z.array(text),
  context: z.number().finite().nonnegative().nullable(),
  price: z.object({ input: z.number().finite().nonnegative().nullable(), output: z.number().finite().nonnegative().nullable() }).strict(),
  release: releaseFactSchema,
  capability: capabilityFactSchema,
  popularity: popularityFactSchema,
  c: z.number().finite().nullable(),
  p: z.number().finite().nonnegative().nullable(),
  n: z.string().regex(/^\d{4}-\d\d-\d\d$/).nullable(),
  evidence_refs: z.object({ capability: z.array(identitySchema), popularity: z.array(identitySchema) }).strict(),
}).strict();

const webDatasetShape = z.object({
  schema_version: z.literal(1),
  audience: z.enum(["local-preview", "public"]),
  revision: text,
  published_at: timestamp,
  evaluated_at: timestamp,
  defaults: rankingDefaults.nullable(),
  profiles: z.array(metricProfileSchema),
  sources: z.array(sourceRevisionSchema),
  attribution: bundleSchema.shape.attribution,
  canonical_source: z.object({ commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), retrieved_at: timestamp.nullable(), url: z.string().url() }).strict(),
  provider_names: z.record(text),
  models: z.array(webRankingModelSchema),
  order: orderSchema,
}).strict();

const publicDatasetShape = webDatasetShape.extend({
  audience: z.literal("public"),
  revision: hash,
  defaults: rankingDefaults.extend({ capability_profile_id: text }),
  models: z.array(webRankingModelSchema).min(1),
});

function checkDataset(value: z.infer<typeof webDatasetShape>, context: z.RefinementCtx) {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  const unique = (ids: string[], path: (string | number)[]) => {
    if (new Set(ids).size !== ids.length) issue(path, "Identifiers must be unique");
  };
  const ids = value.models.map(model => model.id), members = new Set(ids);
  unique(ids, ["models"]);
  unique(value.sources.map(source => source.id), ["sources"]);
  unique(value.profiles.map(profile => profile.id), ["profiles"]);
  for (const mode of ["capability", "popularity", "newest"] as const) {
    const order = value.order[mode];
    unique(order, ["order", mode]);
    if (order.length !== ids.length || order.some(id => !members.has(id))) issue(["order", mode], "Order must contain every model exactly once");
  }
  const sources = new Map(value.sources.map(source => [source.id, source]));
  const profiles = new Map(value.profiles.map(profile => [profile.id, profile]));
  for (const [index, model] of value.models.entries()) {
    unique(model.providers, ["models", index, "providers"]);
    if (model.providers.some(id => !Object.hasOwn(value.provider_names, id))) issue(["models", index, "providers"], "Unknown Provider label");
    const c = model.capability.state === "known" ? model.capability.value.score : null;
    const p = model.popularity.state === "known" ? model.popularity.value.weighted?.score ?? null : null;
    if (model.c !== c) issue(["models", index, "c"], "C must preserve its known score or null state");
    if (model.p !== p) issue(["models", index, "p"], "P must preserve its weighted score or null state");
    if (model.n !== (trustedRelease(model.release, value.evaluated_at) ?? null)) issue(["models", index, "n"], "N must preserve an eligible day-precision release date or null");
    if (value.audience !== "public") continue;
    for (const field of ["release", "capability", "popularity"] as const) {
      const fact = model[field];
      if (fact.state !== "known") continue;
      const source = sources.get(fact.source_id);
      if (source?.usage.redistribution !== "allowed") issue(["models", index, field], "Known public facts require a permitted source");
      if (field === "popularity" && !source?.complete) issue(["models", index, field], "Known public popularity requires a complete source");
    }
    if (model.capability.state === "known") {
      const profile = profiles.get(model.capability.value.profile_id);
      if (!profile || profile.usage.redistribution !== "allowed" || profile.source_id !== model.capability.source_id || profile.id !== value.defaults?.capability_profile_id) issue(["models", index, "capability"], "Public C requires its permitted selected profile");
    }
    if (model.popularity.state === "known" && model.popularity.value.weighted) {
      for (const [id, evidence] of Object.entries(model.popularity.value.weighted.sources)) {
        if (evidence.observed_days && (sources.get(id)?.usage.redistribution !== "allowed" || !sources.get(id)?.complete)) issue(["models", index, "popularity"], "Observed public P components require permitted complete sources");
      }
    }
  }
  if (value.audience === "public") {
    if (!hash.safeParse(value.revision).success) issue(["revision"], "Public revisions must be SHA-256 identifiers");
    if (!value.defaults?.capability_profile_id || !profiles.has(value.defaults.capability_profile_id) || !sources.has(value.defaults.popularity_source_id)) issue(["defaults"], "Public rankings require the selected C profile and P source");
    const missing = ["c", "p", "n"].filter(field => !value.models.some(model => model[field as "c" | "p" | "n"] !== null));
    if (missing.length) issue(["models"], `Public canonical rankings require usable C/P/N; missing: ${missing.join(", ")}`);
  }
}

export const webRankingDatasetSchema = webDatasetShape.superRefine(checkDataset);
export const publicWebRankingDatasetSchema = publicDatasetShape.superRefine(checkDataset);

export function validateWebRankingDataset(input: unknown): WebRankingDataset {
  const data = webRankingDatasetSchema.parse(input);
  if (data.audience === "public") publicWebRankingDatasetSchema.parse(data);
  return data;
}

/** Public structural schema; cross-reference, projection and source checks run above. */
export function webRankingsJsonSchema() {
  const document = zodToJsonSchema(publicDatasetShape, { name: "webRankings", target: "jsonSchema7", $refStrategy: "root" });
  const definition = document.definitions!.webRankings as { properties: { order: { properties: Record<string, object> } } };
  for (const mode of ["capability", "popularity", "newest"]) Object.assign(definition.properties.order.properties[mode]!, { uniqueItems: true });
  return document;
}

if (import.meta.main) {
  const file = Bun.file(new URL("../schema/web-rankings.schema.json", import.meta.url));
  const content = stableStringify(webRankingsJsonSchema());
  if (process.argv.includes("--check")) {
    if (await file.text() !== content) throw new Error("Outdated public web rankings JSON schema");
    console.log("Public web rankings JSON schema matches runtime contract");
  } else {
    await Bun.write(file, content);
    console.log("Generated public web rankings JSON schema");
  }
}
