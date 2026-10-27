import { expect, test } from "bun:test";
import { aaVariantBase, buildMetricIdentityRegistry, canonicalKeys, canonicalMetricTargets, createSourceIdentityResolver, selectAaHeadline } from "../src/metric-identity.js";
import { PUBLIC_SCOPE, type Identity } from "../src/types.js";

const registry = () => buildMetricIdentityRegistry([
  { provider_id: "openrouter", id: "lab/alpha", canonical_id: "lab/alpha", weights: [{ url: "https://huggingface.co/lab/Alpha" }] },
  { provider_id: "openrouter", id: "lab/beta", canonical_id: "lab/beta" },
  { provider_id: "openrouter", id: "lab/alpha:free", canonical_id: "lab/alpha-free" },
  { provider_id: "vercel", id: "lab/alpha", name: "Alpha", canonical_id: "lab/alpha" },
  { provider_id: "opencode-go", id: "alpha", canonical_id: "lab/alpha" },
  { provider_id: "other", id: "alpha", name: "Alpha", canonical_id: "other/alpha" },
]);

test("source namespaces retain free/version/quantization semantics and unknown sources do not guess", () => {
  const resolve = createSourceIdentityResolver(registry());
  expect(resolve("openrouter", { source_model_id: "lab/alpha:free" }).canonical_id).toBe("lab/alpha-free");
  expect(resolve("openrouter", { source_model_id: "lab/alpha:Q4" }).status).toBe("unmatched");
  expect(resolve("opencode-go-free", { source_model_id: "alpha" }).canonical_id).toBe("lab/alpha");
  expect(resolve("vercel-ai-gateway", { source_model_id: "Alpha" }).canonical_id).toBe("lab/alpha");
  expect(resolve("unknown", { source_model_id: "alpha", source_slug: "alpha" }).status).toBe("unmatched");
  expect(resolve("openrouter", { source_model_id: "other", is_aggregate: true }).status).toBe("unmatched");
  expect(canonicalKeys("lab/model-1017-free-q4")).not.toEqual(canonicalKeys("lab/model"));
});

test("OpenRouter retains old catalog slugs but rejects historical retargeting before exact lookup", () => {
  const reg = registry();
  const resolve = createSourceIdentityResolver(reg, { openrouterCatalogs: [
    { data: [{ id: "lab/alpha", canonical_slug: "historic/alpha" }] },
    { data: [{ id: "lab/alpha", canonical_slug: "historic/beta" }] },
  ] });
  for (const id of ["lab/alpha", "historic/alpha", "historic/beta"]) {
    expect(resolve("openrouter", { source_model_id: id })).toMatchObject({ status: "ambiguous", canonical_id: null, method: "openrouter_catalog_identity_changed" });
  }
  const oldOnly = createSourceIdentityResolver(reg, { openrouterCatalogs: [{ data: [{ id: "lab/alpha", canonical_slug: "historic/alpha" }] }, { data: [] }] });
  expect(oldOnly("openrouter", { source_model_id: "historic/alpha" }).canonical_id).toBe("lab/alpha");
});

test("independently resolved aliases permit a safe OpenRouter rename", () => {
  const reg = buildMetricIdentityRegistry([
    { provider_id: "openrouter", id: "route", canonical_id: "lab/alpha" },
    { provider_id: "openrouter", id: "old", canonical_id: "lab/alpha" },
    { provider_id: "openrouter", id: "new", canonical_id: "lab/alpha" },
  ]);
  const resolve = createSourceIdentityResolver(reg, { openrouterCatalogs: [{ data: [{ id: "route", canonical_slug: "old" }] }, { data: [{ id: "route", canonical_slug: "new" }] }] });
  expect(resolve("openrouter", { source_model_id: "route" })).toMatchObject({ status: "matched", canonical_id: "lab/alpha" });
});

test("Vercel display names stay within its source catalog and collisions remain ambiguous", () => {
  const reg = buildMetricIdentityRegistry([...registry().records, { provider_id: "vercel", id: "lab/beta", name: "Alpha", canonical_id: "lab/beta" }]);
  expect(createSourceIdentityResolver(reg)("vercel-ai-gateway", { source_model_id: "Alpha" })).toMatchObject({ status: "ambiguous", canonical_id: null });
});

test("AA explicit identity bridges do not fall through an ambiguous URL to a convenient slug", () => {
  const reg = buildMetricIdentityRegistry([...registry().records, { provider_id: "extra", id: "beta", canonical_id: "lab/beta", weights: [{ url: "https://huggingface.co/lab/Alpha" }] }]);
  const resolve = createSourceIdentityResolver(reg);
  expect(resolve("artificial-analysis", { source_model_id: "aa", source_slug: "alpha", associations: { huggingface_url: "https://huggingface.co/lab/Alpha" } })).toMatchObject({ status: "ambiguous", canonical_id: null, candidates: ["lab/alpha", "lab/beta"] });
  expect(resolve("artificial-analysis", { source_model_id: "aa", associations: { openrouter_api_id: "lab/alpha:free" } }).canonical_id).toBe("lab/alpha-free");
  expect(resolve("artificial-analysis", { source_model_id: "aa", source_slug: "beta", associations: { openrouter_api_id: "lab/beta", huggingface_url: "https://huggingface.co/lab/Alpha" } })).toMatchObject({ status: "ambiguous", canonical_id: null, method: "aa_declared_identity_conflict" });
  expect(createSourceIdentityResolver(registry())("artificial-analysis", { source_model_id: "aa", associations: { openrouter_api_id: "lab/beta", huggingface_url: "https://huggingface.co/lab/Alpha" } })).toMatchObject({ status: "ambiguous", canonical_id: null, candidates: ["lab/alpha", "lab/beta"] });
});

test("AA effort is a separate configuration and headline selection never takes the maximum", () => {
  expect(aaVariantBase("alpha-high", "Alpha (High)")).toBe("alpha");
  expect(aaVariantBase("sonar-reasoning", "Sonar Reasoning")).toBeNull();
  const entries = [
    { source_model_id: "headline", source_slug: "alpha", value: 0, index_version: 4.3 },
    { source_model_id: "high", source_slug: "alpha-high", value: 99, index_version: 4.3 },
  ];
  const selected = selectAaHeadline("lab/alpha", entries);
  expect(selected.selected?.source_model_id).toBe("headline");
  expect(selected.configurations).toHaveLength(2);
  expect(selectAaHeadline("lab/alpha", entries, [4.3, 5]).selected).toBeNull();
  expect(selectAaHeadline("lab/alpha", [...entries, { source_model_id: "unscored", value: null }]).selected?.source_model_id).toBe("headline");
  expect(selectAaHeadline("lab/alpha", [entries[1]!, { ...entries[1]!, source_model_id: "low", source_slug: "alpha-low" }]).selected).toBeNull();
});

test("canonical projection returns only existing identities, retaining protocol and scope without N inheritance", () => {
  const identity: Identity = { provider: "provider", request_model_id: "Exact:free", scope: { ...PUBLIC_SCOPE, protocol: "messages" } };
  const facts = [{ identity, canonical_id: "lab/alpha", release: { state: "unknown" } }, { identity: { ...identity, request_model_id: "other" }, release: { state: "known" } }];
  const before = JSON.stringify(facts);
  expect(canonicalMetricTargets(facts, "lab/alpha")).toEqual([facts[0]!]);
  expect(canonicalMetricTargets(facts, "lab/alpha")[0]!.identity).toBe(identity);
  expect(canonicalMetricTargets(facts, "missing")).toEqual([]);
  expect(JSON.stringify(facts)).toBe(before);
});
