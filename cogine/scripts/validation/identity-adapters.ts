/** Source-scoped identity routes for diagnostic facts, never execution rewrites. */
export type IdentityRouteInput = {
  providerId: string;
  declaredModelsdevProvider?: string | null;
  declaredExpectedBaseUrl?: string | null;
  baseUrl?: string | null;
  requestModelId: string;
  sourceModel?: Record<string, unknown> | null;
};

export type IdentityRoute = {
  status: "declared" | "source_bridge" | "unmapped" | "conflict";
  provider_id: string | null;
  method: string;
  evidence: string;
};

function publicApiBase(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch { return null; }
}

export function resolveUpstreamIdentityRoute(input: IdentityRouteInput): IdentityRoute {
  const none = (method: string, evidence: string): IdentityRoute => ({ status: "unmapped", provider_id: null, method, evidence });
  if (input.providerId === "coginellm" && input.requestModelId === "cogine/free") {
    return none("dynamic_gateway_route", "CogineLLM cogine/free selects a route rather than naming a concrete scored model; its request ID remains unchanged.");
  }
  if (input.declaredModelsdevProvider) {
    const actualBase = publicApiBase(input.baseUrl) ?? input.baseUrl?.replace(/\/+$/, "");
    const expectedBase = publicApiBase(input.declaredExpectedBaseUrl) ?? input.declaredExpectedBaseUrl?.replace(/\/+$/, "");
    if (input.declaredExpectedBaseUrl && actualBase !== expectedBase) {
      return { status: "conflict", provider_id: null, method: "declared_route_base_conflict", evidence: "The source-declared upstream Provider route does not match the source-default API base." };
    }
    return { status: "declared", provider_id: input.declaredModelsdevProvider, method: "declared_coginework_provider_route", evidence: "Reuse the explicit Provider association from CogineWork source; lookup retains the exact request model ID." };
  }
  if (input.providerId === "ollama-cloud" && publicApiBase(input.baseUrl) === "https://ollama.com/v1") {
    return { status: "source_bridge", provider_id: "ollama-cloud", method: "ollama_cloud_exact_public_route", evidence: "The source-default https://ollama.com/v1 matches models.dev providers/ollama-cloud/provider.toml api; all model tags, dates and quantization suffixes are retained for exact lookup." };
  }
  if (input.providerId === "coginellm" && publicApiBase(input.baseUrl) === "https://llm.cogine.ai/v1") {
    const source = input.sourceModel;
    if (source && source.id !== input.requestModelId) {
      return { status: "conflict", provider_id: null, method: "catalog_identity_conflict", evidence: "The catalog metadata belongs to a different exact model ID." };
    }
    if (source?.owned_by === "openrouter") {
      return { status: "source_bridge", provider_id: "openrouter", method: "coginellm_declared_openrouter_namespace", evidence: "The exact model row from https://llm.cogine.ai/v1/models declares owned_by=openrouter; resolve that exact ID within models.dev OpenRouter records without changing the CogineLLM execution route." };
    }
    return none("coginellm_namespace_not_declared", "The exact public catalog row does not declare the OpenRouter namespace; no display-name or global-ID inference is performed.");
  }
  return none("no_source_identity_route", "No explicit upstream Provider association or source-scoped public namespace bridge is available.");
}

/** Preserve duplicates for the caller to report instead of overwriting conflicting metadata. */
export function catalogSourceModels(raw: unknown): Map<string, Record<string, unknown>[]> {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>).data : undefined;
  const result = new Map<string, Record<string, unknown>[]>();
  if (!Array.isArray(data)) return result;
  for (const value of data) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id) continue;
    result.set(row.id, [...(result.get(row.id) ?? []), row]);
  }
  return result;
}

export type CanonicalBridgeField = "capability" | "popularity" | "release";

/** A source's explicit self-identity statement, with no metric or date inheritance. */
export type SourceCanonicalBridge = {
  provider_id: string;
  request_model_id: string;
  canonical_id: string | null;
  status: "declared" | "ambiguous" | "conflict";
  source_url: string;
  source_sha256: string;
  source_kind: string;
  evidence_excerpt: string;
  field_scope: ("capability" | "popularity")[];
  scope: { api_base_url: string; identity_only: true };
  precision: { model_version: string; variant: string; ambiguous: boolean };
};

export type SourceCanonicalBridgeResult = {
  status: "matched" | "unmatched" | "ambiguous" | "conflict";
  canonical_id: string | null;
  candidates: string[];
  evidence: SourceCanonicalBridge[];
};

/**
 * Resolve only a declared source namespace and exact request ID. A successful
 * result supplies an identity reference; the metric source still decides which
 * evaluation configuration or popularity population applies. Release dates are
 * deliberately outside this contract and need version-specific date evidence.
 */
export function resolveSourceCanonicalBridge(
  input: { providerId: string; baseUrl?: string | null; requestModelId: string; field: CanonicalBridgeField },
  bridges: readonly SourceCanonicalBridge[],
): SourceCanonicalBridgeResult {
  const base = publicApiBase(input.baseUrl);
  const evidence = bridges.filter((bridge) =>
    bridge.provider_id === input.providerId &&
    bridge.request_model_id === input.requestModelId &&
    base !== null && publicApiBase(bridge.scope.api_base_url) === base &&
    bridge.scope.identity_only === true &&
    input.field !== "release" && bridge.field_scope.includes(input.field),
  );
  const candidates = [...new Set(evidence.flatMap((bridge) => bridge.canonical_id ? [bridge.canonical_id] : []))].sort();
  const result = (status: SourceCanonicalBridgeResult["status"]): SourceCanonicalBridgeResult => ({
    status, canonical_id: status === "matched" ? candidates[0]! : null, candidates, evidence,
  });
  if (evidence.some((bridge) => bridge.status === "conflict")) return result("conflict");
  if (evidence.some((bridge) => bridge.status === "ambiguous" || bridge.precision.ambiguous) || candidates.length > 1) return result("ambiguous");
  return result(candidates.length === 1 ? "matched" : "unmatched");
}
