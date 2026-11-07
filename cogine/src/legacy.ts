import { z } from "zod";
import { Model, ModelMetadata, ModelShape, Provider, type Model as ProviderModel } from "../../packages/core/src/schema.js";
import { identitySchema } from "./schema.js";
import { identityKey, type Identity } from "./types.js";

export const legacyConfigSchema = z.object({
  schema_version: z.literal(1),
  models: z.array(z.string().min(1)),
  provider_overrides: z.array(z.object({ identity: identitySchema, legacy: z.boolean() }).strict()),
}).strict().superRefine((config, ctx) => {
  if (new Set(config.models).size !== config.models.length) ctx.addIssue({ code: "custom", path: ["models"], message: "Duplicate legacy model ID" });
  const keys = config.provider_overrides.map(entry => identityKey(entry.identity));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["provider_overrides"], message: "Duplicate legacy service identity" });
});
export type LegacyConfig = z.infer<typeof legacyConfigSchema>;

export function legacyResolver(input: unknown) {
  const config = legacyConfigSchema.parse(input);
  const models = new Set(config.models);
  const overrides = new Map(config.provider_overrides.map(entry => [identityKey(entry.identity), entry.legacy]));
  return {
    model: (canonicalId: string) => models.has(canonicalId),
    service: (identity: Identity, canonicalId?: string) => overrides.get(identityKey(identity)) ?? (canonicalId !== undefined && models.has(canonicalId)),
  };
}
export type LegacyResolver = ReturnType<typeof legacyResolver>;

export const legacyModelMetadataSchema = ModelMetadata.extend({ legacy: z.boolean() });
const legacyProviderModelSchema = ModelShape.extend({ legacy: z.boolean() }).superRefine((value, ctx) => {
  const { legacy: _legacy, ...original } = value;
  const parsed = Model.safeParse(original);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue(issue);
});
const legacyProviderSchema = Provider.innerType().extend({ models: z.record(legacyProviderModelSchema) }).superRefine((value, ctx) => {
  const models = Object.fromEntries(Object.entries(value.models).map(([id, { legacy: _legacy, ...model }]) => [id, model]));
  const parsed = Provider.safeParse({ ...value, models });
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue(issue);
});
export const legacyCatalogSchema = z.object({
  models: z.record(legacyModelMetadataSchema),
  providers: z.record(legacyProviderSchema),
}).strict();
export type LegacyCatalog = z.infer<typeof legacyCatalogSchema>;
type Catalog = { models: Record<string, z.infer<typeof ModelMetadata>>; providers: Record<string, z.infer<typeof Provider>> };
type ProtocolCatalog = Record<string, { models: Record<string, { canonical_id?: string; api: Record<string, unknown> }> }>;

/** v1 provider records describe the first API in the upstream resolved API list. */
export function withLegacy(catalog: Catalog, protocols: ProtocolCatalog, resolver: LegacyResolver): LegacyCatalog {
  function serviceLegacy(provider: string, request_model_id: string, model: ProviderModel) {
    const source = protocols[provider]?.models[request_model_id];
    const protocol = source && Object.keys(source.api)[0];
    if (!protocol) return false; // No public protocol identity: do not guess a v1 alias scope.
    if (model.canonical_model_id && source.canonical_id && model.canonical_model_id !== source.canonical_id) throw new Error(`Conflicting canonical identity: ${provider}/${request_model_id}`);
    return resolver.service({ provider, request_model_id, scope: { route: "public", region: "global", plan: "public", protocol } }, source.canonical_id);
  }
  return {
    models: Object.fromEntries(Object.entries(catalog.models).map(([id, model]) => [id, { ...model, legacy: resolver.model(id) }])),
    providers: Object.fromEntries(Object.entries(catalog.providers).map(([id, provider]) => [id, {
      ...provider,
      models: Object.fromEntries(Object.entries(provider.models).map(([modelId, model]) => [modelId, { ...model, legacy: serviceLegacy(id, modelId, model) }])),
    }])),
  };
}
