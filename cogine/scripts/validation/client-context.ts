type Model = { id: string; [key: string]: unknown };
type Provider = { adapter?: string; fallback_models?: Model[] };

// Fixed CogineWork adapter semantics: CogineLLM.fetch_models removes the remote
// cogine/free duplicate, while Provider.get_all_models retains its native seed.
// Other adapters have different catalog replacement rules; do not union their
// packaged fallback catalogs into fresh membership.
export function clientContext(provider: Provider, discovered: Model[]) {
  const result = discovered.map(model => ({ model, basis: "live_catalog_client_projection" }));
  const ids = new Set(discovered.map(model => model.id));
  if (provider.adapter === "CogineLLMProvider") for (const model of provider.fallback_models ?? []) {
    if (!ids.has(model.id)) { result.push({ model, basis: "native_packaged_model" }); ids.add(model.id); }
  }
  return result;
}
