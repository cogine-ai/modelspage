import { expect, test } from "bun:test";
import { ModelMetadata, Provider } from "../../packages/core/src/schema.js";
import { legacyCatalogSchema, legacyConfigSchema, legacyResolver, withLegacy } from "../src/legacy.js";
import type { Identity } from "../src/types.js";
import valid from "../fixtures/contracts/valid-catalog-legacy.json";
import invalid from "../fixtures/contracts/invalid-catalog-legacy.json";
import config from "../config/legacy-models.json";

const identity = (protocol = "messages"): Identity => ({ provider: "host", request_model_id: "old", scope: { route: "public", region: "global", plan: "public", protocol } });
const resolver = legacyResolver({ schema_version: 1, models: ["lab/old"], provider_overrides: [{ identity: identity(), legacy: false }] });

test("legacy has exact version and service scope semantics, including an explicit false exception", () => {
  expect(resolver.model("lab/old")).toBe(true);
  expect(resolver.model("lab/Old")).toBe(false);
  expect(resolver.model("lab/old-20260630")).toBe(false);
  expect(resolver.service(identity(), "lab/old")).toBe(false);
  expect(resolver.service(identity("responses"), "lab/old")).toBe(true);
  expect(resolver.service({ ...identity(), scope: { ...identity().scope, region: "eu" } }, "lab/old")).toBe(true);
});

test("a service-only decision does not require or create a canonical association", () => {
  const scoped = legacyResolver({ schema_version: 1, models: [], provider_overrides: [{ identity: identity(), legacy: true }] });
  expect(scoped.service(identity())).toBe(true);
  expect(scoped.service(identity("chat-completions"))).toBe(false);
  expect(scoped.model("host/old")).toBe(false);
});

test("legacy config rejects duplicate targets and does not require audit metadata", () => {
  expect(legacyConfigSchema.safeParse(config).success).toBe(true);
  expect(legacyConfigSchema.safeParse({ ...config, models: ["lab/old", "lab/old"] }).success).toBe(false);
  expect(legacyConfigSchema.safeParse({ ...config, provider_overrides: [{ identity: identity(), legacy: true }, { identity: identity(), legacy: false }] }).success).toBe(false);
});

test("the opt-in catalog adds only booleans and preserves IDs, order, provider metadata and old schema", () => {
  const original = {
    models: Object.fromEntries(Object.entries(valid.models).map(([id, { legacy: _, ...model }]) => [id, ModelMetadata.parse(model)])),
    providers: Object.fromEntries(Object.entries(valid.providers).map(([id, provider]) => [id, Provider.parse({
      ...provider, models: Object.fromEntries(Object.entries(provider.models).map(([id, { legacy: _, ...model }]) => [id, model])),
    })])),
  };
  const before = structuredClone(original);
  const protocols = { host: { models: {
    old: { canonical_id: "lab/old", api: { messages: {}, "chat-completions": {} } },
    current: { canonical_id: "lab/current", api: { messages: {} } },
  } } };
  const enriched = withLegacy(original, protocols, resolver);
  expect(enriched.models["lab/old"]!.legacy).toBe(true);
  expect(enriched.models["lab/current"]!.legacy).toBe(false);
  expect(enriched.providers.host!.models.old!.legacy).toBe(false);
  expect(original).toEqual(before);
  expect(Object.keys(enriched.models)).toEqual(Object.keys(original.models));
  expect(Object.keys(enriched.providers.host!.models)).toEqual(Object.keys(original.providers.host!.models));
  const { legacy: _, ...metadata } = enriched.models["lab/old"]!;
  expect(metadata).toEqual(original.models["lab/old"]!);
  expect(ModelMetadata.safeParse(metadata).success).toBe(true);
  expect(ModelMetadata.safeParse(enriched.models["lab/old"]).success).toBe(false);
  expect(legacyCatalogSchema.safeParse(enriched).success).toBe(true);
  const reordered = { host: { models: { ...protocols.host.models, old: { ...protocols.host.models.old, api: { "chat-completions": {}, messages: {} } } } } };
  expect(withLegacy(original, reordered, resolver).providers.host!.models.old!.legacy).toBe(true);
  expect(withLegacy(original, {}, resolver).providers.host!.models.old!.legacy).toBe(false);
});

test("legacy contract fixtures reject strings, missing booleans, extra fields and invalid base model fields", () => {
  expect(legacyCatalogSchema.safeParse(valid).success).toBe(true);
  expect(legacyCatalogSchema.safeParse(invalid).success).toBe(false);
  const missing = structuredClone(valid) as any;
  delete missing.models["lab/old"].legacy;
  expect(legacyCatalogSchema.safeParse(missing).success).toBe(false);
  const wrong = structuredClone(valid) as any;
  wrong.models["lab/old"].reviewed_at = "2026-11-07";
  expect(legacyCatalogSchema.safeParse(wrong).success).toBe(false);
  wrong.models["lab/old"] = valid.models["lab/old"];
  wrong.providers.host.models.old.reasoning = true;
  expect(legacyCatalogSchema.safeParse(wrong).success).toBe(false);
});

test("the approved list preserves the canonical total and the two protocol-limited manual decisions", () => {
  const actual = legacyResolver(config);
  expect(config.models).toHaveLength(673);
  for (const [provider, id, protocol] of [["anthropic", "claude-opus-5", "messages"], ["google", "gemini-3.7-flash", "generate-content"]]) {
    expect(actual.model(`${provider}/${id}`)).toBe(false);
    expect(actual.service({ provider: provider!, request_model_id: id!, scope: { route: "public", region: "global", plan: "public", protocol: protocol! } })).toBe(true);
    expect(actual.service({ provider: provider!, request_model_id: id!, scope: { route: "public", region: "global", plan: "public", protocol: "chat-completions" } })).toBe(false);
  }
  expect(actual.model("nace-ai/drex-v1.5")).toBe(true);
  expect(actual.model("nace-ai/drex-v2.0")).toBe(false);
});
