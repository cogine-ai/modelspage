import { expect, test } from "bun:test";
import { catalogSourceModels, resolveSourceCanonicalBridge, resolveUpstreamIdentityRoute, type SourceCanonicalBridge } from "../scripts/validation/identity-adapters.js";

test("reuses an explicit source route and refuses a conflicting API base", () => {
  const input = { providerId: "provider-cn", declaredModelsdevProvider: "provider", declaredExpectedBaseUrl: "https://example.com/v1", baseUrl: "https://example.com/v1/", requestModelId: "Exact.Model:free" };
  expect(resolveUpstreamIdentityRoute(input)).toMatchObject({ status: "declared", provider_id: "provider" });
  expect(resolveUpstreamIdentityRoute({ ...input, baseUrl: "https://other.example/v1" })).toMatchObject({ status: "conflict", provider_id: null });
});

test("Ollama Cloud uses its existing exact upstream Provider without removing tags", () => {
  for (const requestModelId of ["beam", "deepseek-v4-pro:0813", "gpt-oss:120b", "model:cloud", "model:Q4_K_M"]) {
    const input = { providerId: "ollama-cloud", baseUrl: "https://ollama.com/v1/", requestModelId };
    expect(resolveUpstreamIdentityRoute(input)).toMatchObject({ status: "source_bridge", provider_id: "ollama-cloud" });
    expect(input.requestModelId).toBe(requestModelId);
  }
  expect(resolveUpstreamIdentityRoute({ providerId: "ollama-cloud", baseUrl: "http://localhost:11434/v1", requestModelId: "beam" }).provider_id).toBeNull();
});

test("CogineLLM requires the exact source row and its declared OpenRouter namespace", () => {
  const input = { providerId: "coginellm", baseUrl: "https://llm.cogine.ai/v1", requestModelId: "nvidia/model:free", sourceModel: { id: "nvidia/model:free", owned_by: "openrouter" } };
  expect(resolveUpstreamIdentityRoute(input)).toMatchObject({ status: "source_bridge", provider_id: "openrouter" });
  expect(input.requestModelId).toBe("nvidia/model:free");
  expect(resolveUpstreamIdentityRoute({ ...input, sourceModel: undefined }).provider_id).toBeNull();
  expect(resolveUpstreamIdentityRoute({ ...input, sourceModel: { ...input.sourceModel, owned_by: "other" } }).provider_id).toBeNull();
  expect(resolveUpstreamIdentityRoute({ ...input, sourceModel: { ...input.sourceModel, id: "nvidia/model" } }).status).toBe("conflict");
  expect(resolveUpstreamIdentityRoute({ ...input, baseUrl: "https://other.example/v1" }).provider_id).toBeNull();
  expect(resolveUpstreamIdentityRoute({ ...input, requestModelId: "cogine/free", sourceModel: { id: "cogine/free", owned_by: "openrouter" } }).provider_id).toBeNull();
  expect(resolveUpstreamIdentityRoute({ ...input, providerId: "custom" }).provider_id).toBeNull();
});

test("metadata indexing preserves exact IDs and duplicate rows for conflict handling", () => {
  const rows = catalogSourceModels({ data: [{ id: "Model:free", owned_by: "openrouter" }, { id: "Model:free", owned_by: "other" }, { id: "Model" }, { id: "model" }, { name: "no ID" }] });
  expect(rows.size).toBe(3);
  expect(rows.get("Model:free")).toHaveLength(2);
  expect(rows.get("Model")).toHaveLength(1);
  expect(rows.get("model")).toHaveLength(1);
  expect(catalogSourceModels({ models: [] }).size).toBe(0);
});

function selfBridge(overrides: Partial<SourceCanonicalBridge> = {}): SourceCanonicalBridge {
  return {
    provider_id: "modelscope", request_model_id: "org/Model-1017:Q4", canonical_id: "lab/model-1017-q4",
    status: "declared", source_url: "https://modelscope.cn/api/v1/models/org/Model-1017:Q4",
    source_sha256: "a".repeat(64), source_kind: "official_self_model_technical_report", evidence_excerpt: "This exact model is described by the linked report.",
    field_scope: ["capability", "popularity"], scope: { api_base_url: "https://api-inference.modelscope.cn/v1", identity_only: true },
    precision: { model_version: "1017", variant: "Q4", ambiguous: false }, ...overrides,
  };
}

test("self identity bridges retain exact version, suffix, case and API scope", () => {
  const bridge = selfBridge();
  const input = { providerId: "modelscope", baseUrl: "https://api-inference.modelscope.cn/v1/", requestModelId: bridge.request_model_id, field: "capability" as const };
  expect(resolveSourceCanonicalBridge(input, [bridge])).toMatchObject({ status: "matched", canonical_id: "lab/model-1017-q4" });
  for (const requestModelId of ["org/Model", "org/Model-1017", "org/model-1017:Q4", "org/Model-1017:free"]) {
    expect(resolveSourceCanonicalBridge({ ...input, requestModelId }, [bridge]).status).toBe("unmatched");
  }
  expect(resolveSourceCanonicalBridge({ ...input, providerId: "other" }, [bridge]).status).toBe("unmatched");
  expect(resolveSourceCanonicalBridge({ ...input, baseUrl: "https://other.example/v1" }, [bridge]).status).toBe("unmatched");
  expect(resolveSourceCanonicalBridge({ ...input, field: "release" }, [bridge]).status).toBe("unmatched");
  expect(bridge.request_model_id).toBe("org/Model-1017:Q4");
});

test("competing source identities remain ambiguous and recorded conflicts dominate exact matches", () => {
  const bridge = selfBridge();
  const input = { providerId: bridge.provider_id, baseUrl: bridge.scope.api_base_url, requestModelId: bridge.request_model_id, field: "popularity" as const };
  expect(resolveSourceCanonicalBridge(input, [bridge, bridge])).toMatchObject({ status: "matched", candidates: [bridge.canonical_id] });
  expect(resolveSourceCanonicalBridge(input, [bridge, selfBridge({ canonical_id: "lab/model-other" })])).toMatchObject({ status: "ambiguous", canonical_id: null, candidates: ["lab/model-1017-q4", "lab/model-other"] });
  expect(resolveSourceCanonicalBridge(input, [selfBridge({ precision: { ...bridge.precision, ambiguous: true } })]).status).toBe("ambiguous");
  expect(resolveSourceCanonicalBridge(input, [bridge, selfBridge({ status: "conflict" })])).toMatchObject({ status: "conflict", canonical_id: null });
});
