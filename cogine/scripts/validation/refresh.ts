import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

type Row = Record<string, any>;
type Endpoint = { url: string; purpose: string; protocol?: string; requires_auth?: boolean };
type Provider = Row & { id: string; name: string; refresh_urls: Endpoint[]; fallback_models: Row[] };
type Observation = { url: string; retrieved_at: string; status: number | null; sha256: string | null; bytes: number; headers: Record<string, string>; body_path: string | null; error?: string; body?: Row; curl_exit_code: number; credential_mode: string; credential_variable: string | null; stored_body_redacted?: boolean };
type Issue = { code: string; detail: string; model_id?: string };

const DEFAULT_INPUT = ".modelspage/full-validation/inputs/coginework-providers.json";
const DEFAULT_OUTPUT = ".modelspage/full-validation/refresh";
const sha256 = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function atomicJson(path: string, value: unknown) {
  const temporary = path + `.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}
function httpTarget(value: string) {
  const target = new URL(value);
  const hostname = target.hostname.toLowerCase();
  if (target.protocol !== "https:" || target.username || target.password || target.hash || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[|::)/.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) throw new Error("Only the declared public HTTPS catalog endpoints may be probed");
  if ([...target.searchParams.keys()].some(key => /^(api_key|api-key|key|access_token|authorization|bearer)$/i.test(key))) throw new Error("Credentials must never appear in a catalog URL");
  return target;
}
const requestHeaders = (provider: Provider) => provider.discovery_strategy === "anthropic_models" ? ["anthropic-version: 2023-06-01"] : [];
export function validationCredential(provider: Provider): { name: string | null; key: string | undefined } {
  const own = provider.id === "openrouter" ? "MODELSPAGE_OPENROUTER_API_KEY" : `MODELSPAGE_VALIDATE_${provider.id.toUpperCase().replaceAll("-", "_")}_API_KEY`;
  const names = provider.id === "openai-response" ? [own, "MODELSPAGE_VALIDATE_OPENAI_API_KEY"] : [own];
  for (const name of names) { const key = process.env[name]?.trim(); if (key) { if (/[\r\n]/.test(key)) throw new Error(`Invalid multiline value in ${name}`); return { name, key }; } }
  return { name: null, key: undefined };
}
const curlQuote = (value: string) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';

export function continuation(payload: Row, current: URL): { next?: string; unresolved?: string } {
  const scopes = [payload], nextPages = new Set<string>();
  for (let index = 0; index < scopes.length; index++) for (const field of ["pagination", "meta", "metadata"]) { const value = scopes[index]?.[field]; if (value && typeof value === "object" && !Array.isArray(value)) scopes.push(value); }
  for (const scope of scopes) {
    if (scope.error || scope.errors) return { unresolved: "Source reports an error inside catalog metadata" };
    for (const flag of ["has_more", "hasMore", "has_next", "hasNext", "incomplete", "truncated", "complete", "is_complete"]) if (flag in scope && typeof scope[flag] !== "boolean") return { unresolved: `Source reports an invalid ${flag} completion flag` };
    if (scope.incomplete === true || scope.truncated === true || scope.complete === false || scope.is_complete === false) return { unresolved: "Source explicitly reports an incomplete catalog" };
    const links = Array.isArray(scope.links) ? scope.links.filter((link: Row) => link?.rel === "next").map((link: Row) => link.href ?? link.url) : [scope.links?.next];
    for (const link of [...links, scope.next_page_url]) if (typeof link === "string" && link) nextPages.add(new URL(link, current).href);
    if (typeof scope.nextPageToken === "string" && scope.nextPageToken) { const url = new URL(current); url.searchParams.set("pageToken", scope.nextPageToken); nextPages.add(url.href); }
    if (scope.has_more === true && typeof scope.last_id === "string" && scope.last_id) { const url = new URL(current); url.searchParams.set("after_id", scope.last_id); nextPages.add(url.href); }
    if (typeof scope.next === "string" && /^https?:|^\//.test(scope.next)) nextPages.add(new URL(scope.next, current).href);
    else if (scope.next) return { unresolved: "Source next marker has no supported URL contract" };
    for (const marker of ["next_page", "next_page_token", "next_token", "next_cursor", "cursor_next", "continuation_token", "continuationToken", "NextToken", "nextToken", "nextCursor"]) if (scope[marker]) return { unresolved: `Source reports unsupported ${marker} pagination` };
    if ((scope.has_more === true || scope.hasMore === true || scope.has_next === true || scope.hasNext === true) && nextPages.size === 0) return { unresolved: "Source reports continuation without a supported next-page address" };
  }
  return nextPages.size > 1 ? { unresolved: "Source reports conflicting next-page addresses" } : nextPages.size ? { next: [...nextPages][0] } : {};
}

export function parseModels(payload: Row, provider: Provider): { models: Row[]; listed: string[]; issues: Issue[] } {
  if (payload.error || payload.errors) throw new Error("Catalog response carries an error payload");
  const rows = provider.discovery_strategy === "gemini_models" ? payload.models : payload.data;
  if (!Array.isArray(rows)) throw new Error("Model catalog does not contain the expected models[]/data[] array");
  if (provider.id === "tokendance" && rows.length === 0) throw new Error("TokenDance client rejects an empty raw catalog");
  const models: Row[] = [], listed: string[] = [], issues: Issue[] = [];
  const seen = new Set<string>(), projected = new Set<string>();
  const strictIdentities = ["tokendance", "opencode", "opencode-go", "coginellm", "openrouter", "kilo"].includes(provider.id);
  for (const row of rows) {
    if (!row || typeof row !== "object") { if (strictIdentities) throw new Error("Catalog contains a non-object model row"); issues.push({ code: "client_skips_missing_identity", detail: "Generic SDK normalization skips a row with no model ID" }); continue; }
    const rawId = provider.discovery_strategy === "gemini_models" ? row.name : row.id;
    if (strictIdentities && (typeof rawId !== "string" || !rawId.trim())) throw new Error("Catalog contains a model without an exact string identity");
    let id = typeof rawId === "string" ? rawId.trim() : typeof rawId === "number" && rawId ? String(rawId) : rawId === true ? "True" : "";
    if (!id) { issues.push({ code: "client_skips_missing_identity", detail: "Generic SDK normalization skips an empty model ID" }); continue; }
    if (typeof rawId !== "string") issues.push({ code: "client_coerces_non_string_identity", model_id: id, detail: "Generic CogineWork normalization converts this explicit scalar model ID to a string" });
    if (typeof rawId === "string" && id !== rawId) issues.push({ code: "outer_whitespace_normalized_by_client", model_id: rawId, detail: "CogineWork strips only outer whitespace; original value remains in source bytes" });
    if (provider.discovery_strategy === "gemini_models" && id.startsWith("models/")) id = id.slice(7);
    if (!id) { issues.push({ code: "client_skips_missing_identity", detail: "Gemini SDK normalization skips an empty ID after the models/ prefix" }); continue; }
    if (seen.has(id)) { if (["tokendance", "opencode", "opencode-go", "coginellm"].includes(provider.id)) throw new Error(`CogineWork rejects duplicate model identity: ${id}`); issues.push({ code: "duplicate_model_identity", model_id: id, detail: "Duplicate model ID; generic client preserves the first eligible row" }); }
    else { seen.add(id); listed.push(id); }
    const methods = row.supportedGenerationMethods ?? row.supported_actions;
    if (provider.discovery_strategy === "gemini_models" && Array.isArray(methods) && !methods.includes("generateContent")) { issues.push({ code: "client_excludes_non_generate_content", model_id: id, detail: "Gemini client selects models supporting generateContent" }); continue; }
    if (provider.id === "tokendance" && (!Array.isArray(row.supported_protocols) || row.supported_protocols.some((value: unknown) => typeof value !== "string"))) throw new Error(`TokenDance model has invalid supported_protocols: ${id}`);
    if (provider.id === "tokendance" && !row.supported_protocols.includes("openai:chat-completions")) { issues.push({ code: "client_excludes_unsupported_protocol", model_id: id, detail: "TokenDance client requires openai:chat-completions" }); continue; }
    if (provider.id === "coginellm" && id === "cogine/free") { issues.push({ code: "client_keeps_packaged_free_identity", model_id: id, detail: "CogineLLM intentionally excludes the remote duplicate of its packaged Free route" }); continue; }
    if (projected.has(id)) continue;
    projected.add(id);
    const name = provider.discovery_strategy === "gemini_models" ? row.displayName ?? row.display_name : row.name;
    models.push({ id, name: typeof name === "string" && name.trim() ? name.trim() : id, ...(typeof row.release_date === "string" ? { release_date: row.release_date, release_date_source: "provider_catalog" } : {}), ...(row.context_length ? { context_length: row.context_length } : {}), ...(row.architecture ? { architecture: row.architecture } : {}), ...(row.pricing ? { pricing: row.pricing } : {}), ...(row.supported_protocols ? { supported_protocols: row.supported_protocols } : {}), model_protocol: provider.discovery_strategy === "gemini_models" ? "gemini" : provider.discovery_strategy === "anthropic_models" ? "anthropic_messages" : provider.id === "openai-response" ? "responses" : "chat_completions" });
  }
  return { models, listed, issues };
}

export function applyRegistry(provider: Provider, models: Row[], registry: Row, issues: Issue[]): Row[] {
  const namespace = provider.id === "opencode-go" ? "opencode-go" : "opencode";
  const source = registry[namespace];
  if (!source || source.id !== namespace || !source.models || typeof source.models !== "object") throw new Error(`Registry has no exact ${namespace} models map`);
  if (provider.id === "opencode" && source.api !== "https://opencode.ai/inference/openai/v1") throw new Error("Zen registry changed its declared default API contract");
  for (const document of [registry, source]) { const state = continuation(document, new URL("https://models.opencode.ai/api.json")); if (state.next || state.unresolved) throw new Error("Protocol registry is incomplete"); }
  const sdkProtocols: Record<string, string> = { "@ai-sdk/openai-compatible": "chat_completions", "@ai-sdk/openai": "responses", "@ai-sdk/anthropic": "anthropic_messages", "@ai-sdk/google": "unsupported" };
  const result: Row[] = [];
  for (const model of models) {
    const metadata = source.models[model.id];
    if (!metadata) {
      const seed = provider.id === "opencode-go" ? provider.fallback_models.find(row => row.id === model.id && row.model_protocol === "chat_completions" && row.supports_text_output === true) : undefined;
      if (seed) { result.push({ ...seed, id: model.id, metadata_basis: "immutable_packaged_protocol_seed" }); issues.push({ code: "go_uses_packaged_protocol_seed", model_id: model.id, detail: "Exact fresh membership exists but registry protocol is absent; matches CogineWork fallback projection" }); }
      else if (provider.id === "opencode") { result.push({ ...model, model_protocol: "unknown", supports_text_output: null }); issues.push({ code: "unknown_registry_contract", model_id: model.id, detail: "Zen keeps membership but cannot grant protocol capability from a missing registry entry" }); }
      else issues.push({ code: "client_excludes_unknown_registry_contract", model_id: model.id, detail: "Go keeps listed membership evidence but excludes unresolved transport" });
      continue;
    }
    if (metadata.id !== model.id) throw new Error(`Registry key/ID mismatch for ${model.id}`);
    const npm = metadata.provider?.npm ?? source.npm;
    let protocol = sdkProtocols[npm] ?? "unsupported";
    if (provider.id === "opencode") {
      const expectedApi = npm === "@ai-sdk/anthropic" ? "https://opencode.ai/inference/anthropic/v1" : npm === "@ai-sdk/google" ? "https://opencode.ai/inference/google/v1beta" : "https://opencode.ai/inference/openai/v1";
      if ((metadata.provider?.api ?? source.api) !== expectedApi) protocol = "unsupported";
    }
    if (!metadata.modalities || !Array.isArray(metadata.modalities.output) || metadata.modalities.output.some((value: unknown) => typeof value !== "string")) throw new Error(`Registry has invalid output modalities: ${model.id}`);
    if (provider.id === "opencode" && (!Array.isArray(metadata.modalities.input) || metadata.modalities.input.some((value: unknown) => typeof value !== "string"))) throw new Error(`Zen registry has invalid input modalities: ${model.id}`);
    const name = metadata.name === undefined ? model.id : metadata.name;
    if (typeof name !== "string" || !name.trim()) throw new Error(`Registry has invalid model name: ${model.id}`);
    const textOutput = metadata.modalities.output.includes("text");
    if (provider.id === "opencode-go" && (protocol !== "chat_completions" || !textOutput)) { issues.push({ code: "client_excludes_unsupported_registry_transport", model_id: model.id, detail: `Go client currently only admits text Chat Completions; registry protocol=${protocol}` }); continue; }
    if (provider.id === "opencode-go" && metadata.status) { if (typeof metadata.status !== "string") throw new Error(`Go registry has invalid lifecycle status: ${model.id}`); issues.push({ code: "go_lifecycle_change", model_id: model.id, detail: `Registry reports lifecycle status ${metadata.status}` }); }
    result.push({ ...model, name: name.trim(), model_protocol: protocol, supports_text_output: textOutput, ...(metadata.release_date ? { release_date: metadata.release_date, release_date_source: "opencode_registry" } : {}), ...(metadata.limit ? { limit: metadata.limit } : {}), metadata_basis: "fresh_official_registry" });
  }
  return result;
}

class Semaphore {
  private running = 0;
  private queue: (() => void)[] = [];
  async run<T>(action: () => Promise<T>) { if (this.running >= 4) await new Promise<void>(resolve => this.queue.push(resolve)); this.running++; try { return await action(); } finally { this.running--; this.queue.shift()?.(); } }
}

export async function runRefresh(inputPath = DEFAULT_INPUT, outputPath = DEFAULT_OUTPUT, selectedIds: string[] = []) {
  const inputBytes = await readFile(inputPath), inputHash = sha256(inputBytes);
  const document = JSON.parse(inputBytes.toString("utf8"));
  const providers = document.providers as Provider[];
  if (!Array.isArray(providers) || providers.length === 0 || new Set(providers.map(provider => provider.id)).size !== providers.length) throw new Error("Expected the complete unique CogineWork provider inventory");
  if (selectedIds.some(id => !providers.some(provider => provider.id === id))) throw new Error("Requested subset contains a Provider outside the fixed inventory");
  await mkdir(outputPath, { recursive: true });
  await mkdir(join(outputPath, "raw"), { recursive: true });
  await mkdir(join(outputPath, "history"), { recursive: true });
  const startedAt = new Date().toISOString(), semaphore = new Semaphore(), hosts = new Map<string, Promise<unknown>>();
  async function preserveAttempt(result: Row) {
    const bytes = JSON.stringify(result, null, 2) + "\n";
    const name = `${result.provider_id}-${String(result.attempted_at ?? "undated").replaceAll(/[^\w-]/g, "-")}-${sha256(bytes).slice(0, 16)}.json`;
    const path = join(outputPath, "history", name);
    if (await Bun.file(path).exists()) { if (await Bun.file(path).text() !== bytes) throw new Error("An immutable attempt path has different content"); }
    else await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  }
  async function request(provider: Provider, endpoint: string, index: number): Promise<Observation> {
    const target = httpTarget(endpoint), previous = hosts.get(target.host) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => semaphore.run(async () => {
      const stem = `${provider.id}-${index}-${sha256(endpoint).slice(0, 10)}`;
      const credential = target.origin === new URL(provider.base_url).origin ? validationCredential(provider) : { name: null, key: undefined };
      const authHeader = credential.key ? provider.discovery_strategy === "anthropic_models" ? `x-api-key: ${credential.key}` : provider.discovery_strategy === "gemini_models" ? `x-goog-api-key: ${credential.key}` : `Authorization: Bearer ${credential.key}` : undefined;
      const headersConfig = [...requestHeaders(provider), ...(authHeader ? [authHeader] : [])].map(value => `header = ${curlQuote(value)}`).join("\n") + "\n";
      const argv = ["curl", "-q", "--silent", "--show-error", "--connect-timeout", "8", "--max-time", "22", "--max-filesize", "10000000", "--header", "Accept: application/json", "--header", "Accept-Encoding: identity", "--header", "User-Agent: Modelspage-catalog-validation/1", "--config", "-", "--dump-header", "-", "--output", "-", "--write-out", "\nMODELSPAGE_HTTP_META:%{http_code}:%{size_header}\n", target.href];
      const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(headersConfig); child.stdin.end();
      const [exit, output, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
      const wire = Buffer.from(output), marker = Buffer.from("\nMODELSPAGE_HTTP_META:"), markerIndex = wire.lastIndexOf(marker);
      const metadata = markerIndex >= 0 ? wire.subarray(markerIndex + marker.length).toString("utf8").match(/^(\d{3}):(\d+)\n$/) : null;
      const retrievedAt = new Date().toISOString(), status = metadata && metadata[1] !== "000" ? Number(metadata[1]) : null;
      const headerBytes = metadata ? Number(metadata[2]) : 0;
      const validMetadata = !!metadata && Number.isSafeInteger(headerBytes) && headerBytes >= 0 && headerBytes <= markerIndex;
      const rawHeaders = validMetadata ? wire.subarray(0, headerBytes).toString("utf8") : "";
      const headers: Record<string, string> = {};
      for (const line of rawHeaders.split(/\r?\n/)) { const split = line.indexOf(":"); if (split < 0) continue; const key = line.slice(0, split).toLowerCase(); if (["content-type", "content-encoding", "content-length", "etag", "last-modified", "retry-after"].includes(key)) headers[key] = line.slice(split + 1).trim().replaceAll(credential.key ?? "\u0000", "[REDACTED_VALIDATION_KEY]"); }
      const bytes = validMetadata ? wire.subarray(headerBytes, markerIndex) : new Uint8Array();
      const originalHash = bytes.length ? sha256(bytes) : null;
      const observation: Observation = { url: target.href, retrieved_at: retrievedAt, status, curl_exit_code: exit, sha256: originalHash, bytes: bytes.length, headers, body_path: null, credential_mode: credential.key ? "dedicated_validation_key" : "anonymous", credential_variable: credential.name };
      const bodyText = new TextDecoder().decode(bytes);
      let decoded: Row | undefined;
      try { decoded = JSON.parse(bodyText); } catch { /* Non-JSON error bodies remain diagnostic source evidence. */ }
      let storedBytes: Uint8Array = bytes;
      if (credential.key && (bodyText.includes(credential.key) || JSON.stringify(decoded ?? null).includes(credential.key))) { storedBytes = new TextEncoder().encode('{"error":"validation_credential_echo_excluded"}\n'); observation.stored_body_redacted = true; observation.error = "Response echoed a validation credential; excluded from normalization"; }
      if (storedBytes.length) {
        const bodyPath = join(outputPath, "raw", `${stem}-${sha256(storedBytes)}.json`);
        if (await Bun.file(bodyPath).exists()) { if (sha256(new Uint8Array(await Bun.file(bodyPath).arrayBuffer())) !== sha256(storedBytes)) throw new Error("An immutable response path has different content"); }
        else await writeFile(bodyPath, storedBytes, { mode: 0o600, flag: "wx" });
        observation.body_path = resolve(bodyPath);
      }
      if (exit !== 0) observation.error = `curl exit ${exit}: ${stderr.trim().replaceAll(credential.key ?? "\u0000", "[REDACTED_VALIDATION_KEY]").slice(0, 350)}`;
      else if (!validMetadata) observation.error = "Transport response metadata is invalid";
      else if (status !== null && status >= 200 && status < 300 && !observation.stored_body_redacted) {
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) observation.error = "Successful HTTP response is not a JSON object";
        else observation.body = decoded;
        if (headers["content-encoding"] && headers["content-encoding"] !== "identity") observation.error = `Source ignored identity encoding: ${headers["content-encoding"]}`;
      }
      console.log(JSON.stringify({ provider: provider.id, url: target.href, status, bytes: bytes.length, error: observation.error ?? null }));
      await sleep(250);
      return observation;
    }));
    hosts.set(target.host, pending);
    return pending;
  }
  async function refresh(provider: Provider) {
    const attemptStarted = new Date().toISOString();
    let credential: ReturnType<typeof validationCredential> = { name: null, key: undefined }, credentialError: unknown;
    try { credential = validationCredential(provider); } catch (error) { credentialError = error; }
    const result: Row = { schema_version: 1, provider_id: provider.id, provider_name: provider.name, attempted_at: attemptStarted, credential_mode: credential.key ? "dedicated_validation_key" : "anonymous_public_catalog_only", credential_variable: credential.name, observation_scope: credential.key ? "dedicated_key_visible_catalog" : "public_catalog", source_revision: document.coginework?.commit ?? document.coginework?.head ?? document.source_revision ?? document.source?.commit ?? null, inventory_sha256: inputHash, status: "not_run", reason: "", requests: [], models: [], live_membership_models: [], listed_model_ids: [], membership_complete: false, issues: [], fallback: { kind: "immutable_packaged_catalog", latest: false, catalog_key: provider.fallback_catalog_key ?? null, models: provider.fallback_models ?? [] } };
    const issues = result.issues as Issue[], observations: Observation[] = [];
    try {
      if (credentialError) throw credentialError;
      if (provider.is_local || ["coginework-local", "ollama", "lmstudio", "acciowork-local-agent"].includes(provider.id)) { result.status = "not_run_local"; result.reason = "Local inventory cannot be treated as public catalog data; no local model service was queried"; }
      else if (provider.id === "openai-codex") { result.status = "not_run_private_subscription"; result.reason = "Codex refresh is an OAuth/account-scoped catalog; no private credential or account directory accessed"; }
      else if (provider.discovery_strategy === "catalog_only" || provider.discovery_strategy === "unsupported" || provider.model_sync_mode === "disabled") { result.status = "not_supported"; result.reason = provider.discovery_reason || "CogineWork declares no supported remote model refresh for this Provider"; }
      else {
        const endpoints = provider.refresh_urls ?? [];
        const membership = endpoints.find(endpoint => !/metadata|registry/i.test(endpoint.purpose)) ?? endpoints[0];
        if (!membership) { result.status = "not_configured"; result.reason = "No public refresh endpoint can be derived from the fixed CogineWork source"; }
        else {
          const initial = new URL(membership.url);
          if (provider.id === "openrouter") initial.searchParams.set("sort", "newest");
          let next: string | undefined = initial.href, page = 0;
          const origin = httpTarget(next).origin, visited = new Set<string>(), ids = new Set<string>();
          let models: Row[] = [], listed: string[] = [], complete = true, expectedTotal: number | undefined;
          while (next) {
            if (page >= 30 || visited.has(next)) throw new Error("Pagination repeated an endpoint or exceeded 30 pages");
            if (httpTarget(next).origin !== origin) throw new Error("Catalog pagination changed origin");
            visited.add(next);
            const observed = await request(provider, next, ++page); observations.push(observed);
            if (!observed.body || observed.error || observed.status === null || observed.status < 200 || observed.status >= 300) {
              const status = observed.status;
              result.status = status === 401 ? "requires_auth" : status === 403 ? "forbidden" : status === 404 || status === 405 ? "unsupported_endpoint" : status === 429 ? "rate_limited" : status !== null && status >= 500 ? "provider_unavailable" : status !== null && status >= 300 && status < 400 ? "redirect_not_followed" : observed.curl_exit_code === 28 ? "timeout" : observed.error && status !== null ? "invalid_response" : "network_error";
              result.reason = observed.error ?? `HTTP ${status}; ${observed.credential_mode === "dedicated_validation_key" ? "dedicated validation key" : "anonymous request"}`;
              complete = false; break;
            }
            const decoded = parseModels(observed.body, provider); issues.push(...decoded.issues);
            if ("total_count" in observed.body) { const total = observed.body.total_count; if (!Number.isSafeInteger(total) || total < 0 || expectedTotal !== undefined && expectedTotal !== total) throw new Error("Catalog total_count is invalid or changed across pages"); expectedTotal = total; }
            for (const id of decoded.listed) { if (ids.has(id)) throw new Error(`Model identity repeated across pages: ${id}`); ids.add(id); }
            models.push(...decoded.models); listed.push(...decoded.listed);
            const continuationResult = continuation(observed.body, new URL(next));
            if (continuationResult.unresolved) { complete = false; result.status = "partial"; result.reason = continuationResult.unresolved; break; }
            next = continuationResult.next;
          }
          if (complete && expectedTotal !== undefined && expectedTotal !== listed.length) { complete = false; result.status = "partial"; result.reason = `Catalog total_count=${expectedTotal}, received ${listed.length} unique model IDs`; }
          result.expected_total_count = expectedTotal ?? null;
          result.live_membership_models = models;
          result.listed_model_ids = listed;
          result.membership_complete = complete;
          if (complete) {
            const metadata = endpoints.find(endpoint => /metadata|registry/i.test(endpoint.purpose));
            if (metadata && listed.length > 0 && ["opencode", "opencode-go"].includes(provider.id)) {
              const observed = await request(provider, metadata.url, ++page); observations.push(observed);
              if (!observed.body || observed.error || observed.status !== 200) { result.status = "partial"; result.reason = "Fresh membership obtained, but the required official protocol registry refresh failed"; }
              else { models = applyRegistry(provider, models, observed.body, issues); result.status = "refreshed"; result.models = models; }
            } else { result.status = "refreshed"; result.models = models; }
            if (result.status === "refreshed") result.reason = credential.key ? "Completed the declared catalog refresh using a dedicated validation key; no inference request" : "Completed the declared public catalog refresh; no credentials or inference request";
          }
        }
      }
    } catch (error) { result.status = observations.length ? "invalid_response" : "configuration_error"; result.reason = error instanceof Error ? error.message : "Catalog refresh failed"; }
    result.requests = observations.map(({ body: _body, ...observation }) => observation);
    result.completed_at = new Date().toISOString(); result.live_model_count = result.models.length; result.listed_model_count = result.listed_model_ids.length;
    result.fallback_model_count = result.fallback.models.length;
    if (result.status === "refreshed" && !credential.key && provider.discovery_requires_auth) issues.push({ code: "anonymous_membership_is_not_account_qualification", detail: "Public HTTP catalog succeeded, while the CogineWork adapter declares authenticated discovery; account-visible availability was not validated" });
    if (result.status !== "refreshed") issues.push({ code: result.status, detail: result.reason });
    const path = join(outputPath, provider.id + ".json");
    if (await Bun.file(path).exists()) await preserveAttempt(JSON.parse(await readFile(path, "utf8")));
    await preserveAttempt(result);
    await atomicJson(path, result);
    if (result.status === "refreshed") await atomicJson(join(outputPath, provider.id + ".last-good.json"), result);
    return result;
  }
  const selected = selectedIds.length ? providers.filter(provider => selectedIds.includes(provider.id)) : providers;
  const attempted = await Promise.all(selected.map(refresh));
  const results = selectedIds.length ? await Promise.all(providers.map(async provider => {
    const updated = attempted.find(row => row.provider_id === provider.id);
    if (updated) return updated;
    const path = join(outputPath, provider.id + ".json");
    if (!await Bun.file(path).exists()) return { provider_id: provider.id, provider_name: provider.name, status: "not_run", reason: "Not included in this selected-provider rerun and no preceding observation exists", live_model_count: 0, listed_model_count: 0, fallback_model_count: provider.fallback_models.length, membership_complete: false, issues: [] };
    const saved = JSON.parse(await readFile(path, "utf8"));
    if (saved.source_revision !== (document.coginework?.commit ?? document.coginework?.head ?? null)) throw new Error("Cannot merge refresh observations from a different CogineWork source revision");
    return saved;
  })) : attempted;
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  const index = { schema_version: 1, validation_level: "read-only HTTP catalogs with CogineWork source-derived normalization; installed-client workflows not executed", started_at: startedAt, completed_at: new Date().toISOString(), selected_provider_ids: selected.map(provider => provider.id), input_path: resolve(inputPath), input_sha256: inputHash, provider_count: providers.length, counts, refreshed_provider_count: results.filter(row => row.status === "refreshed").length, refreshed_model_count: results.reduce((total, row) => total + row.live_model_count, 0), listed_model_count: results.reduce((total, row) => total + row.listed_model_count, 0), results: results.map(row => ({ provider_id: row.provider_id, provider_name: row.provider_name, status: row.status, reason: row.reason, live_model_count: row.live_model_count, listed_model_count: row.listed_model_count, fallback_model_count: row.fallback_model_count, membership_complete: row.membership_complete, issue_count: row.issues.length, path: resolve(join(outputPath, row.provider_id + ".json")) })) };
  await atomicJson(join(outputPath, "index.json"), index);
  console.log(JSON.stringify({ provider_count: providers.length, counts, refreshed_model_count: index.refreshed_model_count, output: resolve(outputPath) }));
  return index;
}

if (import.meta.main) {
  process.umask(0o077);
  const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" }, only: { type: "string" } } });
  await runRefresh(values.input ?? DEFAULT_INPUT, values.output ?? DEFAULT_OUTPUT, values.only?.split(",").filter(Boolean));
}
