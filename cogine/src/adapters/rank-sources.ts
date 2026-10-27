import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { atomicWrite, sha256, stableStringify } from "../integrity.js";

export type Status = "success" | "authentication_required" | "failed" | "partial";
export type RankSourceEntry = {
  source_model_id: string;
  display_name?: string;
  source_slug?: string;
  model_creator?: string;
  date?: string;
  window_label?: string;
  metric: string;
  value: number | string | null;
  value_unit: string;
  source_rank?: number;
  source_position?: number;
  ranking_eligible?: boolean;
  index_version?: number | string;
  associations?: { openrouter_api_id?: string; huggingface_url?: string };
  is_aggregate?: boolean;
};
export type RankSourceSnapshot = {
  schema_version: 1;
  source_id: string;
  attempted_at: string;
  retrieved_at: string | null;
  data_as_of: string | null;
  data_as_of_precision: "timestamp" | "day" | null;
  status: Status;
  complete_response: boolean;
  coverage_truncated: boolean;
  cutoff: string;
  scope: string;
  window: { start: string | null; end: string | null; label: string };
  usage: { collection: "allowed" | "diagnostic_only" | "unverified" | "disabled"; redistribution: "allowed" | "unverified" | "disabled"; evidence: string };
  authentication_provided: boolean;
  endpoints: string[];
  raw_files: { path: string; sha256: string; bytes: number }[];
  entries: RankSourceEntry[];
  issues: string[];
  metadata: Record<string, unknown>;
  profile?: Record<string, unknown>;
  content_sha256?: string;
};

export const RANK_SOURCE_IDS = ["artificial-analysis", "openrouter", "vercel-ai-gateway", "opencode-go-free"] as const;
export type RankSourceId = typeof RANK_SOURCE_IDS[number];
export type RankSourceFetchOptions = { now?: string; fetcher?: typeof fetch; anonymousCatalogDiagnostic?: boolean };
const iso = () => new Date().toISOString();
function clock(now?: string) {
  const value = now ?? iso();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Ranking collection requires a valid ISO observation clock");
  return value;
}
const allowedCredentialNames = ["MODELSPAGE_AA_API_KEY", "ARTIFICIAL_ANALYSIS_API_KEY", "AA_API_KEY", "MODELSPAGE_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"];
function currentSecrets() { return allowedCredentialNames.map(key => process.env[key]).filter((value): value is string => !!value); }
export function assertNoCredentialEcho(value: unknown): void {
  const secrets = currentSecrets();
  const visit = (item: unknown): boolean => {
    if (typeof item === "string") return secrets.some(secret => item.includes(secret));
    if (Array.isArray(item)) return item.some(visit);
    if (item && typeof item === "object") return Object.entries(item).some(([key, child]) => visit(key) || visit(child));
    return false;
  };
  if (visit(value)) throw new Error("Source response rejected because it echoed a configured credential; response body discarded");
}
function safeMessage(error: unknown) {
  let message = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === "string" ? error : "Source collection failed";
  for (const secret of currentSecrets()) message = message.replaceAll(secret, "[REDACTED]");
  return message.slice(0, 500);
}
function credential(names: string[]) { return names.map(name => process.env[name]).find(value => !!value); }
function requireObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, any>;
}
function requireArray(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim().length > 0 ? value : undefined; }
function assertNoContinuation(data: Record<string, any>, label: string) {
  if (data.next || data.next_cursor || data.has_more || data.links?.next || data.pagination?.has_more || data.pagination?.next || data.pagination?.next_cursor) throw new Error(`${label} indicates unconsumed pagination`);
}
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function wholeCount(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

// Curl uses the host's ordinary TLS configuration. Authentication headers travel on
// stdin, never command arguments, output, saved request metadata, or public fixtures.
async function getJson(url: string, headers: Record<string, string> = {}, options: RankSourceFetchOptions = {}) {
  if (options.fetcher) {
    const response = await options.fetcher(url, { headers: { Accept: "application/json", ...headers }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    return parsedResponse(await response.text(), response.status, response.headers.get("content-type") ?? "", options.now);
  }
  const config = [`url = ${JSON.stringify(url)}`, 'header = "Accept: application/json"'];
  for (const [name, value] of Object.entries(headers)) {
    if (/[\r\n]/.test(name + value)) throw new Error("Invalid source credential/header");
    config.push(`header = ${JSON.stringify(`${name}: ${value}`)}`);
  }
  const child = Bun.spawn(["curl", "-q", "--config", "-", "--silent", "--show-error", "--connect-timeout", "10", "--max-time", "30", "--max-filesize", "20000000", "--write-out", "\nMODELSPAGE_HTTP_META:%{http_code}:%{content_type}\n"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(config.join("\n") + "\n"); child.stdin.end();
  const [bodyWithMeta, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Network transport exit ${code}: ${safeMessage(stderr.trim())}`);
  const marker = bodyWithMeta.lastIndexOf("\nMODELSPAGE_HTTP_META:");
  if (marker < 0) throw new Error("Transport response metadata missing");
  const [statusText, ...contentTypeParts] = bodyWithMeta.slice(marker + "\nMODELSPAGE_HTTP_META:".length).trim().split(":");
  return parsedResponse(bodyWithMeta.slice(0, marker), Number(statusText), contentTypeParts.join(":"), options.now);
}
function parsedResponse(body: string, status: number, contentType: string, now?: string) {
  if (status !== 200) throw new HttpError(status);
  if (!contentType.toLowerCase().includes("json")) throw new Error(`Expected JSON, received ${contentType || "no content type"}`);
  if (Buffer.byteLength(body) > 20_000_000) throw new Error("Ranking source response exceeds size limit");
  assertNoCredentialEcho(body);
  let json: unknown;
  try { json = JSON.parse(body); }
  catch { throw new Error("Source response is invalid JSON; response body discarded"); }
  assertNoCredentialEcho(json);
  return { body, json, retrievedAt: clock(now) };
}
class HttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); this.name = "HttpError"; }
}
async function saveRaw(outDir: string, snapshot: RankSourceSnapshot, name: string, body: string) {
  assertNoCredentialEcho(body);
  assertNoCredentialEcho(JSON.parse(body));
  const hash = sha256(body);
  const path = `${snapshot.source_id}/raw/${hash}-${name}`;
  const file = Bun.file(join(outDir, path));
  if (await file.exists()) {
    if (sha256(await file.text()) !== hash) throw new Error("Immutable raw source object has conflicting contents");
  } else await atomicWrite(join(outDir, path), body);
  snapshot.raw_files.push({ path, sha256: hash, bytes: Buffer.byteLength(body) });
}

function base(sourceId: string, options: Pick<RankSourceSnapshot, "scope" | "cutoff" | "usage">, now?: string): RankSourceSnapshot {
  return { schema_version: 1, source_id: sourceId, attempted_at: clock(now), retrieved_at: null, data_as_of: null, data_as_of_precision: null, status: "failed", complete_response: false, coverage_truncated: false, scope: options.scope, cutoff: options.cutoff, usage: options.usage, authentication_provided: false, endpoints: [], raw_files: [], entries: [], issues: [], metadata: {}, window: { start: null, end: null, label: "Source has not supplied explicit boundaries" } };
}
function fail(snapshot: RankSourceSnapshot, error: unknown) {
  snapshot.status = error instanceof HttpError && [401, 403].includes(error.status) && snapshot.authentication_provided ? "authentication_required" : snapshot.entries.length ? "partial" : "failed";
  snapshot.complete_response = false;
  snapshot.issues.push(safeMessage(error));
  if (error instanceof HttpError) snapshot.metadata.http_status = error.status;
}

export async function collectAa(outDir: string, options: RankSourceFetchOptions = {}): Promise<RankSourceSnapshot> {
  const snapshot = base("artificial-analysis", { scope: "AA published language-model Intelligence Index, preserving each AA model/effort record", cutoff: "AA catalog coverage; missing score is unknown, not zero", usage: { collection: "diagnostic_only", redistribution: "unverified", evidence: "https://artificialanalysis.ai/data-api and Data Platform Terms: API access alone does not establish public JSON redistribution rights." } }, options.now);
  const key = credential(["MODELSPAGE_AA_API_KEY", "ARTIFICIAL_ANALYSIS_API_KEY", "AA_API_KEY"]);
  snapshot.authentication_provided = !!key;
  if (!key) {
    snapshot.status = "authentication_required";
    snapshot.issues.push("No dedicated AA API key in the explicitly permitted project environment variables. No private credential search or authenticated request was performed.");
    return snapshot;
  }
  let endpoint = "https://artificialanalysis.ai/api/v2/language/models";
  let first: Awaited<ReturnType<typeof getJson>>;
  try {
    try { first = await getJson(endpoint, { "x-api-key": key }, options); }
    catch (error) {
      if (!(error instanceof HttpError) || error.status !== 403) throw error;
      snapshot.metadata.full_endpoint_forbidden = true;
      endpoint = "https://artificialanalysis.ai/api/v2/language/models/free";
      first = await getJson(endpoint, { "x-api-key": key }, options);
    }
    let result = first;
    let page = 1;
    let expectedPages: number | undefined;
    let version: number | string | undefined;
    const ids = new Set<string>();
    while (true) {
      const data = requireObject(result.json, "AA response");
      const pagination = requireObject(data.pagination, "AA pagination");
      const totalPages = Number(pagination.total_pages);
      if (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > 100 || Number(pagination.page) !== page || typeof pagination.has_more !== "boolean") throw new Error("Invalid AA pagination contract");
      if (expectedPages !== undefined && totalPages !== expectedPages) throw new Error("AA total_pages changed during collection");
      expectedPages = totalPages;
      const currentVersion = data.intelligence_index_version;
      if (!(text(currentVersion) || typeof currentVersion === "number" && Number.isFinite(currentVersion)) || version !== undefined && currentVersion !== version) throw new Error("AA Intelligence Index version missing or changed between pages");
      version = currentVersion;
      const rows = requireArray(data.data, "AA data");
      for (const rowInput of rows) {
        const row = requireObject(rowInput, "AA model");
        const id = text(row.id); const slug = text(row.slug); const name = text(row.name);
        if (!id || !slug || !name || ids.has(id)) throw new Error("AA model has missing/duplicate identity");
        ids.add(id);
        snapshot.entries.push({ source_model_id: id, source_slug: slug, display_name: name, model_creator: text(row.model_creator?.name), metric: "artificial_analysis_intelligence_index", value: finite(row.evaluations?.artificial_analysis_intelligence_index), value_unit: "AA Intelligence Index points", index_version: version, associations: { ...(text(row.openrouter_api_id) ? { openrouter_api_id: row.openrouter_api_id } : {}), ...(text(row.huggingface_url) ? { huggingface_url: row.huggingface_url } : {}) } });
      }
      snapshot.endpoints.push(page === 1 ? endpoint : `${endpoint}?page=${page}`);
      await saveRaw(outDir, snapshot, `page-${page}.json`, result.body);
      snapshot.retrieved_at = result.retrievedAt;
      snapshot.metadata.tier = data.tier;
      if (!pagination.has_more) {
        if (page !== totalPages) throw new Error("AA pagination ended before total_pages");
        break;
      }
      if (page >= totalPages) throw new Error("AA pagination continues after total_pages");
      page++;
      result = await getJson(`${endpoint}?page=${page}`, { "x-api-key": key }, options);
    }
    if (!snapshot.entries.length) throw new Error("AA catalog is empty");
    snapshot.metadata.intelligence_index_version = version;
    snapshot.metadata.pages = page;
    snapshot.status = "success"; snapshot.complete_response = true;
    snapshot.issues.push("AA API version contains major.minor only; do not manufacture a patch version or merge independent reasoning records.");
  } catch (error) { fail(snapshot, error); }
  return snapshot;
}

export async function collectVercel(outDir: string, options: RankSourceFetchOptions = {}): Promise<RankSourceSnapshot> {
  const url = "https://vercel.com/api/ai/leaderboard-export?dataset=models&modality=text";
  const snapshot = base("vercel-ai-gateway", { scope: "Vercel AI Gateway public text-model daily usage shares, not whole-market calls", cutoff: "Published top model series plus Other; long-tail individual shares may be absent", usage: { collection: "allowed", redistribution: "allowed", evidence: "https://vercel.com/changelog/open-data-and-shareable-charts-for-ai-gateway-leaderboards — public JSON/CSV, CC BY 4.0 with attribution and changes indicated." } }, options.now);
  snapshot.endpoints.push(url);
  try {
    const result = await getJson(url, {}, options);
    const data = requireObject(result.json, "Vercel export");
    assertNoContinuation(data, "Vercel export");
    if (data.dataset !== "models" || data.modality !== "text" || data.license !== "CC-BY-4.0") throw new Error("Unexpected Vercel export dataset, modality or license");
    const dates = new Set<string>(); const metrics = new Set<string>(); const keys = new Set<string>();
    for (const rowInput of requireArray(data.rows, "Vercel rows")) {
      const row = requireObject(rowInput, "Vercel row");
      const name = text(row.name); const date = text(row.date); const metric = text(row.metric); const share = finite(row.share_percent);
      if (!name || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !metric || share === null || share < 0 || share > 100 || row.group !== "model" || row.modality !== "text") throw new Error("Invalid Vercel daily share row");
      const key = JSON.stringify([name, date, metric]); if (keys.has(key)) throw new Error("Duplicate Vercel model/date/metric row"); keys.add(key);
      dates.add(date); metrics.add(metric);
      snapshot.entries.push({ source_model_id: name, display_name: name, date, metric, value: share, value_unit: "platform daily share percent", is_aggregate: name === "Other" });
    }
    if (!snapshot.entries.length) throw new Error("Vercel export is empty");
    await saveRaw(outDir, snapshot, "export.json", result.body);
    const orderedDates = [...dates].sort();
    snapshot.retrieved_at = result.retrievedAt;
    snapshot.window = { start: orderedDates[0]!, end: orderedDates.at(-1)!, label: "Native exported daily buckets; shares are not absolute request/token counts" };
    snapshot.metadata = { license: data.license, license_url: data.license_url, metrics: [...metrics].sort(), day_count: dates.size, latest_source_bucket_date: orderedDates.at(-1)!, other_rows: snapshot.entries.filter(row => row.source_model_id === "Other").length };
    snapshot.status = "success"; snapshot.complete_response = true; snapshot.coverage_truncated = true;
    snapshot.issues.push("Model display names are the export's source identifiers; no model ID or canonical mapping is fabricated.", "Averaging daily shares gives mean daily share, not a volume-weighted period share without daily platform totals.", "The export supplies bucket dates but no global source data_as_of; the newest day may still be partial.");
  } catch (error) { fail(snapshot, error); }
  return snapshot;
}

export async function collectOpenCode(outDir: string, options: RankSourceFetchOptions = {}): Promise<RankSourceSnapshot> {
  const url = "https://opencode.ai/data/index.json";
  const snapshot = base("opencode-go-free", { scope: "OpenCode public site Go/Free sample per official stats source, not all Zen/BYOK traffic", cutoff: "Native leaderboard top 18 and selected daily chart series plus Other; absent individual tail is not zero", usage: { collection: "diagnostic_only", redistribution: "unverified", evidence: "https://opencode.ai/data methodology/citation plus official stats source ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb; endpoint-specific redistribution terms not established." } }, options.now);
  snapshot.endpoints.push(url);
  try {
    const result = await getJson(url, {}, options);
    const data = requireObject(result.json, "OpenCode data");
    assertNoContinuation(data, "OpenCode data");
    const updatedAt = text(data.updatedAt);
    if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) throw new Error("OpenCode updatedAt is missing/invalid");
    const leaderboard = requireObject(data.leaderboard, "OpenCode leaderboard");
    for (const label of ["pastWeek", "pastDay"]) {
      const seen = new Set<string>();
      for (const rowInput of requireArray(leaderboard[label], `OpenCode ${label}`)) {
        const row = requireObject(rowInput, "OpenCode model"); const id = text(row.model); const tokens = wholeCount(row.tokens);
        if (!id || !tokens || seen.has(id) || !Number.isSafeInteger(row.rank) || row.rank < 1) throw new Error("Invalid OpenCode model/token/rank row");
        seen.add(id);
        snapshot.entries.push({ source_model_id: id, display_name: text(row.name), model_creator: text(row.lab), window_label: label, metric: "tokens", value: tokens, value_unit: "input + output + reasoning + cached tokens (source definition)", source_rank: row.rank });
      }
    }
    const dailyTotals: { date: string; total_tokens: string; reported_models_sum_tokens: string; rounding_delta_tokens: string; model_ids: string[] }[] = [];
    const seenDays = new Set<string>();
    for (const rowInput of requireArray(data.dailyTokens, "OpenCode dailyTokens")) {
      const row = requireObject(rowInput, "OpenCode daily token row");
      const date = text(row.date); const total = wholeCount(row.total); const models = requireObject(row.models, "OpenCode daily models");
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !total || seenDays.has(date)) throw new Error("Invalid OpenCode daily date/total");
      seenDays.add(date);
      let modelSum = 0n;
      for (const [modelId, value] of Object.entries(models)) {
        const tokens = wholeCount(value); if (!modelId || tokens === null) throw new Error("Invalid OpenCode native daily model/token value");
        modelSum += BigInt(tokens);
        snapshot.entries.push({ source_model_id: modelId, date, window_label: "UTC day", metric: "tokens", value: tokens, value_unit: "source-reported input + output + reasoning + cached tokens", is_aggregate: modelId === "Other" });
      }
      dailyTotals.push({ date, total_tokens: total, reported_models_sum_tokens: modelSum.toString(), rounding_delta_tokens: (modelSum - BigInt(total)).toString(), model_ids: Object.keys(models) });
    }
    if (!snapshot.entries.length) throw new Error("OpenCode leaderboard is empty");
    await saveRaw(outDir, snapshot, "index.json", result.body);
    snapshot.retrieved_at = result.retrievedAt; snapshot.data_as_of = updatedAt; snapshot.data_as_of_precision = "timestamp";
    snapshot.window.label = "Native pastWeek/pastDay; exact start/end not supplied in leaderboard records";
    const orderedDays = dailyTotals.map(row => row.date).sort();
    snapshot.metadata = { daily_tokens_rows: dailyTotals.length, daily_tokens_window: { start: orderedDays[0] ?? null, end: orderedDays.at(-1) ?? null, grain: "UTC day" }, daily_tokens_totals: dailyTotals, daily_unique_users_rows: Array.isArray(data.dailyUniqueUsers) ? data.dailyUniqueUsers.length : null, source_scope_code: "https://github.com/anomalyco/opencode/blob/ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb/packages/stats/core/src/domain/home.ts#L149" };
    snapshot.status = "success"; snapshot.complete_response = true; snapshot.coverage_truncated = true;
    snapshot.issues.push("Go, Free and Zen must not be assigned independent weights without distinct sampling evidence.", "Native total includes cached/reasoning tokens; it is not a request count.", "Daily chart series are truncated to displayed model IDs plus native Other; daily total is retained separately as the denominator, not reconstructed from top-18 rankings.", "Native chart values may be rounded independently; model-sum minus native-total deltas are recorded without adjustment. The current UTC day may be partial.");
  } catch (error) { fail(snapshot, error); }
  return snapshot;
}

export async function collectOpenRouter(outDir: string, options: RankSourceFetchOptions = {}): Promise<RankSourceSnapshot> {
  const key = credential(["MODELSPAGE_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"]);
  const snapshot = base("openrouter", { scope: key ? "OpenRouter public rankings dataset, not account activity" : "One unauthenticated public model-catalog diagnostic with native top-weekly sort", cutoff: key ? "Official selected time bucket top 50 plus Other; individual tail unknown" : "Complete model catalog does not establish per-item weekly usage coverage", usage: { collection: key ? "allowed" : "diagnostic_only", redistribution: key ? "allowed" : "unverified", evidence: key ? "https://openrouter.ai/docs/api/api-reference/datasets/daily-token-totals-for-top-50-models — CC BY 4.0, citation and meta retained." : "Public /models endpoint usage terms remain unverified; diagnostic only, production configuration unchanged." } }, options.now);
  snapshot.authentication_provided = !!key;
  if (!key && !options.anonymousCatalogDiagnostic) {
    snapshot.status = "authentication_required";
    snapshot.issues.push("The official token-ranking dataset requires a dedicated OpenRouter API key; a model catalog is not substituted for token usage.");
    return snapshot;
  }
  try {
    if (key) {
      const today = new Date(clock(options.now)); today.setUTCHours(0, 0, 0, 0);
      const start = new Date(today); start.setUTCDate(start.getUTCDate() - 7);
      const end = new Date(today); end.setUTCDate(end.getUTCDate() - 1);
      const startDate = start.toISOString().slice(0, 10); const endDate = end.toISOString().slice(0, 10);
      const url = `https://openrouter.ai/api/v1/datasets/rankings-daily?start_date=${startDate}&end_date=${endDate}&period=day&modality=text`;
      snapshot.endpoints.push(url);
      const result = await getJson(url, { Authorization: `Bearer ${key}` }, options);
      const data = requireObject(result.json, "OpenRouter dataset"); const meta = requireObject(data.meta, "OpenRouter meta");
      await saveRaw(outDir, snapshot, "rankings-day.json", result.body);
      const asOf = text(meta.as_of);
      if (meta.start_date !== startDate || meta.end_date !== endDate || !asOf || !Number.isFinite(Date.parse(asOf)) || !text(meta.version)) throw new Error("OpenRouter response meta does not match requested date window or lacks source timestamp/version");
      assertNoContinuation(data, "OpenRouter dataset");
      const rows = requireArray(data.data, "OpenRouter data");
      if (!rows.length) throw new Error("OpenRouter dataset is empty");
      const expectedDays = Array.from({ length: 7 }, (_, offset) => new Date(start.getTime() + offset * 86400000).toISOString().slice(0, 10));
      const seen = new Set<string>(); const byDay = new Map<string, RankSourceEntry[]>();
      for (const rowInput of rows) {
        const row = requireObject(rowInput, "OpenRouter dataset row"); const id = text(row.model_permaslug); const date = text(row.date); const tokens = wholeCount(row.total_tokens);
        if (!id || !date || !expectedDays.includes(date) || tokens === null) throw new Error("Invalid OpenRouter model/date/token row");
        const identity = JSON.stringify([date, id]);
        if (seen.has(identity)) throw new Error("Duplicate OpenRouter model/date row"); seen.add(identity);
        const entry = { source_model_id: id, date, window_label: "UTC day", metric: "tokens", value: tokens, value_unit: "provider-native prompt + completion tokens", is_aggregate: id === "other" };
        snapshot.entries.push(entry);
        const daily = byDay.get(date) ?? []; daily.push(entry); byDay.set(date, daily);
      }
      if (expectedDays.some(day => !byDay.has(day))) throw new Error("OpenRouter response omits a requested complete UTC day");
      const dailyTotals = expectedDays.map(date => {
        const daily = byDay.get(date)!;
        if (daily.length > 51 || daily.filter(row => !row.is_aggregate).length > 50) throw new Error("OpenRouter daily bucket exceeds documented top-50 cutoff");
        return { date, total_tokens: daily.reduce((sum, row) => sum + BigInt(row.value!), 0n).toString(), reported_models: daily.filter(row => !row.is_aggregate).length, other_tokens: daily.find(row => row.is_aggregate)?.value ?? "0", denominator_source: "Documented top-50 plus native other covers the entire filtered daily dataset" };
      });
      snapshot.retrieved_at = result.retrievedAt; snapshot.data_as_of = asOf; snapshot.data_as_of_precision = "timestamp";
      snapshot.window = { start: startDate, end: endDate, label: "Latest seven complete UTC days, period=day, modality=text; no sampled category/language filters" };
      snapshot.metadata = { meta, period: "day", modality: "text", daily_tokens_totals: dailyTotals, source_metric: "Provider tokenizers differ; quantities are platform usage signals, not universal equivalent tokens", pagination_contract: "Official dataset is a single array of up to 51 rows per day; no nonempty next-page indicator permitted" };
      snapshot.status = "success"; snapshot.complete_response = true; snapshot.coverage_truncated = true;
    } else {
      const url = "https://openrouter.ai/api/v1/models?sort=top-weekly&output_modalities=all&limit=1000&offset=0";
      snapshot.endpoints.push(url);
      const result = await getJson(url, {}, options);
      const data = requireObject(result.json, "OpenRouter models"); const rows = requireArray(data.data, "OpenRouter models data");
      const seen = new Set<string>();
      for (const [index, rowInput] of rows.entries()) {
        const row = requireObject(rowInput, "OpenRouter model"); const id = text(row.id);
        if (!id || seen.has(id)) throw new Error("OpenRouter catalog identity missing or duplicate"); seen.add(id);
        snapshot.entries.push({ source_model_id: id, display_name: text(row.name), metric: "native_top_weekly_sort_order", value: index + 1, value_unit: "catalog source position, not a measured usage count", source_position: index + 1, ranking_eligible: false });
      }
      await saveRaw(outDir, snapshot, "models-top-weekly-diagnostic.json", result.body);
      snapshot.retrieved_at = result.retrievedAt;
      const total = Number(data.total_count); const next = data.links?.next;
      snapshot.complete_response = Number.isSafeInteger(total) && total === rows.length && next === null && rows.length > 0;
      snapshot.status = snapshot.complete_response ? "success" : "partial";
      snapshot.metadata = { catalog_total: Number.isSafeInteger(total) ? total : null, received: rows.length, next: typeof next === "string" ? next : null, official_rankings_dataset: "authentication_required", native_source_order_available: true, production_eligibility_reason: "This is an unapproved diagnostic source, not a per-model manual review decision" };
      snapshot.issues.push("No dedicated OpenRouter API key; official CC-BY rankings dataset was not requested.", "Native sorted catalog positions are retained diagnostically, without inventing counts or claiming every tail item has weekly usage evidence.");
    }
  } catch (error) { fail(snapshot, error); }
  return snapshot;
}

export type RankSourceAttempt = {
  kind: "ranking" | "catalog";
  source_id: string;
  status: Status | "not_modified" | "disabled";
  attempted_at: string;
  retrieved_at: string | null;
  changed: boolean;
  complete_response: boolean;
  retained_last_good: boolean;
  snapshot_path?: string;
  last_good_path?: string;
  error?: string;
};
export type RankSourceCatalog = {
  schema_version: 1;
  source_id: "openrouter" | "vercel-ai-gateway";
  endpoint: string;
  retrieved_at: string | null;
  sha256: string;
  complete_response: true;
  usage: RankSourceSnapshot["usage"];
  entries: { id: string; name?: string; canonical_slug?: string; owned_by?: string }[];
};

const timestamp = z.string().datetime({ offset: true });
const usageSchema = z.object({ collection: z.enum(["allowed", "diagnostic_only", "unverified", "disabled"]), redistribution: z.enum(["allowed", "unverified", "disabled"]), evidence: z.string().min(1) }).strict();
const rankEntrySchema = z.object({
  source_model_id: z.string().min(1), display_name: z.string().optional(), source_slug: z.string().optional(), model_creator: z.string().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), window_label: z.string().optional(),
  metric: z.string().min(1), value: z.union([z.number().finite(), z.string().regex(/^\d+$/)]).nullable(), value_unit: z.string().min(1), source_rank: z.number().int().positive().optional(), source_position: z.number().int().positive().optional(), ranking_eligible: z.boolean().optional(), index_version: z.union([z.string().min(1), z.number().finite()]).optional(),
  associations: z.object({ openrouter_api_id: z.string().optional(), huggingface_url: z.string().optional() }).strict().optional(), is_aggregate: z.boolean().optional(),
}).strict();
const snapshotSchema = z.object({
  schema_version: z.literal(1), source_id: z.string().regex(/^[a-z0-9-]+$/), attempted_at: timestamp, retrieved_at: timestamp.nullable(), data_as_of: z.string().nullable(), data_as_of_precision: z.enum(["timestamp", "day"]).nullable(), status: z.enum(["success", "authentication_required", "failed", "partial"]), complete_response: z.boolean(), coverage_truncated: z.boolean(), cutoff: z.string(), scope: z.string(),
  window: z.object({ start: z.string().nullable(), end: z.string().nullable(), label: z.string() }).strict(), usage: usageSchema, authentication_provided: z.boolean(), endpoints: z.array(z.string().url()), raw_files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() }).strict()), entries: z.array(rankEntrySchema), issues: z.array(z.string()), metadata: z.record(z.unknown()), profile: z.record(z.unknown()).optional(), content_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export function validateRankSourceSnapshot(input: unknown): RankSourceSnapshot {
  assertNoCredentialEcho(input);
  const snapshot = snapshotSchema.parse(input) as RankSourceSnapshot;
  if (snapshot.status === "success" && (!snapshot.complete_response || !snapshot.entries.length || !snapshot.retrieved_at)) throw new Error("Successful ranking snapshot is incomplete");
  const keys = snapshot.entries.map(entry => stableStringify([entry.source_model_id, entry.metric, entry.date, entry.window_label]));
  if (new Set(keys).size !== keys.length) throw new Error("Ranking snapshot contains duplicate model/metric/window rows");
  for (const file of snapshot.raw_files) if (!file.path.startsWith(snapshot.source_id + "/") || file.path.split(/[\\/]/).includes("..")) throw new Error("Ranking raw object path escapes its source state");
  if (snapshot.content_sha256 && snapshot.content_sha256 !== rankSourceContentHash(snapshot)) throw new Error("Ranking snapshot semantic content hash mismatch");
  return snapshot;
}
function profileFor(snapshot: RankSourceSnapshot): Record<string, unknown> {
  switch (snapshot.source_id) {
    case "artificial-analysis": return { metric: "artificial_analysis_intelligence_index", source_version: snapshot.metadata.intelligence_index_version ?? null, tier: snapshot.metadata.tier ?? null, configurations: "Separate source model/effort IDs; no maximum-score substitution" };
    case "openrouter": return { metric: snapshot.authentication_provided ? "platform_daily_token_share" : "catalog_native_sort_diagnostic", source_version: (snapshot.metadata.meta as Record<string, unknown> | undefined)?.version ?? null, modality: snapshot.metadata.modality ?? null, token_definition: "prompt + completion, native provider tokenizers", grain: "UTC day" };
    case "vercel-ai-gateway": return { metric: "platform_daily_share_percent", metrics: snapshot.metadata.metrics ?? [], grain: "UTC day", population: "AI Gateway text usage" };
    case "opencode-go-free": return { metric: "platform_daily_token_share", token_definition: "input + output + reasoning + cached", population: "Go/Free", grain: "UTC day; rolling native ranks retained separately" };
    default: return { metric: [...new Set(snapshot.entries.map(entry => entry.metric))].sort() };
  }
}
/** Operational clocks, raw formatting, and source as_of-only updates do not create new facts. */
export function rankSourceContentHash(snapshot: RankSourceSnapshot): string {
  const entries = [...snapshot.entries].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b), "en"));
  const totals = Array.isArray(snapshot.metadata.daily_tokens_totals) ? [...snapshot.metadata.daily_tokens_totals].map(value => {
    const row = value as Record<string, unknown>;
    return { ...row, ...(Array.isArray(row.model_ids) ? { model_ids: [...row.model_ids].sort() } : {}) } as Record<string, unknown>;
  }).sort((a, b) => String(a.date).localeCompare(String(b.date), "en")) : [];
  return sha256(stableStringify({ source_id: snapshot.source_id, entries, profile: snapshot.profile ?? profileFor(snapshot), window: snapshot.window, scope: snapshot.scope, cutoff: snapshot.cutoff, coverage_truncated: snapshot.coverage_truncated, usage: snapshot.usage, daily_tokens_totals: totals }));
}
async function immutable(path: string, body: string) {
  assertNoCredentialEcho(body);
  const file = Bun.file(path);
  if (await file.exists()) { if (await file.text() !== body) throw new Error("Immutable ranking state path has conflicting contents"); }
  else await atomicWrite(path, body);
}
export async function persistSnapshot(outDir: string, input: RankSourceSnapshot): Promise<RankSourceAttempt> {
  const snapshot = validateRankSourceSnapshot(input);
  snapshot.profile ??= profileFor(snapshot);
  snapshot.content_sha256 = rankSourceContentHash(snapshot);
  const sourceDir = join(outDir, snapshot.source_id), latestPath = join(sourceDir, "snapshot.json"), goodPath = join(sourceDir, "last-good.json");
  let previous: RankSourceSnapshot | undefined;
  let previousBody: string | undefined;
  const latest = Bun.file(latestPath), good = Bun.file(goodPath);
  if (await latest.exists()) {
    const body = await latest.text();
    const old = validateRankSourceSnapshot(JSON.parse(body));
    await immutable(join(sourceDir, "history", `${sha256(body)}.json`), body);
    if (!await good.exists() && old.status === "success" && old.complete_response) await atomicWrite(goodPath, body);
  }
  if (await good.exists()) { previousBody = await good.text(); previous = validateRankSourceSnapshot(JSON.parse(previousBody)); }
  const success = snapshot.status === "success" && snapshot.complete_response;
  const unchanged = !!previous && (success && rankSourceContentHash(previous) === snapshot.content_sha256 || snapshot.metadata.http_status === 304);
  if (!success && previous) snapshot.metadata.last_good_retained = { path: `${snapshot.source_id}/last-good.json`, retrieved_at: previous.retrieved_at, data_as_of: previous.data_as_of, entries: previous.entries.length };
  const body = stableStringify(snapshot);
  await immutable(join(sourceDir, "history", `${sha256(body)}.json`), body);
  if (success && !unchanged) await atomicWrite(goodPath, body);
  await atomicWrite(latestPath, unchanged ? previousBody! : body);
  const attempt: RankSourceAttempt = { kind: "ranking", source_id: snapshot.source_id, status: unchanged ? "not_modified" : snapshot.status, attempted_at: snapshot.attempted_at, retrieved_at: snapshot.retrieved_at, changed: success && !unchanged, complete_response: unchanged || success, retained_last_good: !!previous && (!success || unchanged), snapshot_path: `${snapshot.source_id}/snapshot.json`, last_good_path: success || previous ? `${snapshot.source_id}/last-good.json` : undefined, ...(!success && !unchanged ? { error: snapshot.issues.join("; ").slice(0, 500) } : {}) };
  await atomicWrite(join(sourceDir, "attempt.json"), stableStringify(attempt));
  return attempt;
}
export async function readRankSourceSnapshots(stateDir: string, options: { publicOnly?: boolean; sourceIds?: readonly string[] } = {}): Promise<RankSourceSnapshot[]> {
  const snapshots: RankSourceSnapshot[] = [];
  for (const id of options.sourceIds ?? RANK_SOURCE_IDS) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Invalid ranking source ID");
    let file = Bun.file(join(stateDir, id, "last-good.json"));
    if (!await file.exists()) file = Bun.file(join(stateDir, id, "snapshot.json"));
    if (!await file.exists()) continue;
    const snapshot = validateRankSourceSnapshot(await file.json());
    if (snapshot.source_id !== id) throw new Error("Ranking state source identity mismatch");
    if (snapshot.status !== "success" || !snapshot.complete_response) continue;
    if (!options.publicOnly || snapshot.usage.collection === "allowed" && snapshot.usage.redistribution === "allowed") snapshots.push(snapshot);
  }
  return snapshots;
}

const catalogSchema = z.object({ schema_version: z.literal(1), source_id: z.enum(["openrouter", "vercel-ai-gateway"]), endpoint: z.string().url(), retrieved_at: timestamp.nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/), complete_response: z.literal(true), usage: usageSchema, entries: z.array(z.object({ id: z.string().min(1), name: z.string().optional(), canonical_slug: z.string().optional(), owned_by: z.string().optional() }).strict()).min(1) }).strict();
export function validateRankSourceCatalog(input: unknown): RankSourceCatalog {
  assertNoCredentialEcho(input);
  const catalog = catalogSchema.parse(input);
  if (new Set(catalog.entries.map(entry => entry.id)).size !== catalog.entries.length) throw new Error("Source catalog has duplicate exact IDs");
  return catalog;
}
function catalogDigest(catalog: RankSourceCatalog) { return sha256(stableStringify({ ...catalog, retrieved_at: undefined, sha256: undefined, entries: [...catalog.entries].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) })); }
const catalogUrls = { openrouter: "https://openrouter.ai/api/v1/models?sort=top-weekly&output_modalities=all&limit=1000&offset=0", "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1/models" } as const;
function parseCatalog(source: keyof typeof catalogUrls, body: string, json: unknown, retrievedAt: string | null): RankSourceCatalog {
  const data = requireObject(json, "Source catalog"); assertNoContinuation(data, "Source catalog");
  const rows = requireArray(data.data, "Source catalog data");
  if (!rows.length || data.total_count !== undefined && data.total_count !== rows.length) throw new Error("Source catalog is empty or incomplete");
  const entries = rows.map(value => { const row = requireObject(value, "Source model"); const id = text(row.id); if (!id) throw new Error("Source catalog ID is missing"); return { id, ...(text(row.name) ? { name: row.name } : {}), ...(text(row.canonical_slug) ? { canonical_slug: row.canonical_slug } : {}), ...(text(row.owned_by) ? { owned_by: row.owned_by } : {}) }; });
  return validateRankSourceCatalog({ schema_version: 1, source_id: source, endpoint: catalogUrls[source], retrieved_at: retrievedAt, sha256: sha256(body), complete_response: true, usage: { collection: "diagnostic_only", redistribution: "unverified", evidence: "Public official identity catalog only; leaderboard/data-set licensing does not automatically license this separate endpoint. Historical exact ID/name/slug pairs retained for local identity resolution." }, entries });
}
async function saveCatalog(stateDir: string, catalog: RankSourceCatalog) {
  const path = join(stateDir, catalog.source_id, "catalog-history", `${catalogDigest(catalog)}.json`);
  if (await Bun.file(path).exists()) {
    const previous = validateRankSourceCatalog(await Bun.file(path).json());
    if (catalogDigest(previous) !== catalogDigest(catalog)) throw new Error("Catalog semantic history path has conflicting contents");
  } else await immutable(path, stableStringify(catalog));
}
export async function readRankSourceCatalogs(stateDir: string): Promise<RankSourceCatalog[]> {
  const catalogs = new Map<string, RankSourceCatalog>();
  const add = (catalog: RankSourceCatalog) => { const key = catalogDigest(catalog); if (!catalogs.has(key)) catalogs.set(key, catalog); };
  for (const source of Object.keys(catalogUrls) as (keyof typeof catalogUrls)[]) {
    const directory = join(stateDir, source);
    if (!existsSync(directory)) continue;
    for await (const path of new Bun.Glob("catalog-history/*.json").scan({ cwd: directory })) add(validateRankSourceCatalog(await Bun.file(join(directory, path)).json()));
    const good = Bun.file(join(directory, "catalog-last-good.json"));
    if (await good.exists()) add(validateRankSourceCatalog(await good.json()));
    const names = source === "openrouter" ? ["models-top-weekly-diagnostic.json", "models-catalog-public-latest.json"] : ["catalog-public.json"];
    for (const name of names) {
      const file = Bun.file(join(directory, name));
      if (await file.exists()) { const body = await file.text(); add(parseCatalog(source, body, JSON.parse(body), null)); }
    }
    const pattern = source === "openrouter" ? "identity-history/*-models*.json" : "identity-history/*-catalog-public.json";
    for await (const path of new Bun.Glob(pattern).scan({ cwd: directory })) {
      const body = await Bun.file(join(directory, path)).text(); add(parseCatalog(source, body, JSON.parse(body), null));
    }
  }
  return [...catalogs.values()].sort((a, b) => a.source_id.localeCompare(b.source_id, "en") || catalogDigest(a).localeCompare(catalogDigest(b), "en"));
}
async function collectCatalog(stateDir: string, source: keyof typeof catalogUrls, previous: RankSourceCatalog[], options: RankSourceFetchOptions): Promise<RankSourceAttempt> {
  const sourcePrevious = previous.filter(catalog => catalog.source_id === source);
  const attempt: RankSourceAttempt = { kind: "catalog", source_id: source, status: "failed", attempted_at: clock(options.now), retrieved_at: null, changed: false, complete_response: false, retained_last_good: sourcePrevious.length > 0 };
  try {
    const response = await getJson(catalogUrls[source], {}, options);
    const catalog = parseCatalog(source, response.body, response.json, response.retrievedAt);
    const observation = base(source, { scope: "Public official identity catalog", cutoff: "Complete returned catalog", usage: catalog.usage }, options.now);
    await saveRaw(stateDir, observation, "catalog-public.json", response.body);
    attempt.retrieved_at = response.retrievedAt;
    const unchanged = sourcePrevious.some(previous => catalogDigest(previous) === catalogDigest(catalog));
    attempt.status = unchanged ? "not_modified" : "success"; attempt.complete_response = true; attempt.changed = !unchanged; attempt.retained_last_good = unchanged;
    if (!unchanged) {
      await saveCatalog(stateDir, catalog);
      await atomicWrite(join(stateDir, source, "catalog-last-good.json"), stableStringify(catalog));
      const legacy = source === "openrouter" ? "models-catalog-public-latest.json" : "catalog-public.json";
      const legacyPath = join(stateDir, source, legacy);
      if (await Bun.file(legacyPath).exists()) { const body = await Bun.file(legacyPath).text(); await immutable(join(stateDir, source, "identity-history", `${sha256(body)}-${legacy}`), body); }
      await atomicWrite(legacyPath, response.body);
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 304 && sourcePrevious.length) { attempt.status = "not_modified"; attempt.complete_response = true; }
    else attempt.error = safeMessage(error);
  }
  await atomicWrite(join(stateDir, source, "catalog-attempt.json"), stableStringify(attempt));
  return attempt;
}
export type CollectRankSourcesOptions = RankSourceFetchOptions & {
  stateDir: string;
  sourceIds?: readonly RankSourceId[];
  disabledSourceIds?: readonly RankSourceId[];
  previousSnapshots?: readonly RankSourceSnapshot[];
  previousCatalogs?: readonly RankSourceCatalog[];
  includeCatalogs?: boolean;
  usageOverrides?: Record<string, RankSourceSnapshot["usage"]>;
};
export type CollectedRankSources = { snapshots: RankSourceSnapshot[]; attempts: RankSourceAttempt[]; catalogs: RankSourceCatalog[] };
export async function collectRankSources(options: CollectRankSourcesOptions): Promise<CollectedRankSources> {
  const stateDir = resolve(options.stateDir), now = clock(options.now);
  const sourceIds = options.sourceIds ?? RANK_SOURCE_IDS;
  if (new Set(sourceIds).size !== sourceIds.length || sourceIds.some(id => !RANK_SOURCE_IDS.includes(id))) throw new Error("Unknown or repeated ranking source ID");
  assertNoCredentialEcho(options.usageOverrides);
  const usageOverrides = Object.fromEntries(Object.entries(options.usageOverrides ?? {}).map(([id, usage]) => [id, usageSchema.parse(usage)]));
  for (const input of options.previousSnapshots ?? []) {
    const snapshot = validateRankSourceSnapshot(input);
    if (snapshot.status !== "success" || !snapshot.complete_response) continue;
    const file = join(stateDir, snapshot.source_id, "last-good.json");
    if (!await Bun.file(file).exists()) await atomicWrite(file, stableStringify(snapshot));
  }
  for (const input of options.previousCatalogs ?? []) await saveCatalog(stateDir, validateRankSourceCatalog(input));
  const collectors = { "artificial-analysis": collectAa, "vercel-ai-gateway": collectVercel, "opencode-go-free": collectOpenCode, openrouter: collectOpenRouter };
  const attempts = await Promise.all(sourceIds.map(async id => {
    if (options.disabledSourceIds?.includes(id)) return { kind: "ranking" as const, source_id: id, status: "disabled" as const, attempted_at: now, retrieved_at: null, changed: false, complete_response: false, retained_last_good: (await readRankSourceSnapshots(stateDir, { sourceIds: [id] })).length > 0 };
    const snapshot = await collectors[id](stateDir, { ...options, now });
    // Reviewed dataset policy belongs in the semantic comparison. Separate
    // identity catalogs keep their own endpoint-specific rights below.
    if (usageOverrides[id]) snapshot.usage = usageOverrides[id];
    return persistSnapshot(stateDir, snapshot);
  }));
  const previousCatalogs = await readRankSourceCatalogs(stateDir);
  // Migrate historical explicit pairs before refreshing so changing route aliases remain visible.
  for (const catalog of previousCatalogs) await saveCatalog(stateDir, catalog);
  if (options.includeCatalogs !== false) {
    const selected = (Object.keys(catalogUrls) as (keyof typeof catalogUrls)[]).filter(id => sourceIds.includes(id) && !options.disabledSourceIds?.includes(id));
    attempts.push(...await Promise.all(selected.map(id => collectCatalog(stateDir, id, previousCatalogs, { ...options, now }))));
  }
  const snapshots = await readRankSourceSnapshots(stateDir);
  const catalogs = await readRankSourceCatalogs(stateDir);
  const sources = snapshots.map(snapshot => {
    const attempt = attempts.find(item => item.kind === "ranking" && item.source_id === snapshot.source_id);
    return { source_id: snapshot.source_id, status: attempt?.status ?? snapshot.status, complete_response: snapshot.complete_response, coverage_truncated: snapshot.coverage_truncated, entries: snapshot.entries.length, retrieved_at: snapshot.retrieved_at, data_as_of: snapshot.data_as_of, snapshot_path: `${snapshot.source_id}/last-good.json`, issues: snapshot.issues, retained_last_good: attempt?.retained_last_good ?? false };
  });
  for (const attempt of attempts.filter(item => item.kind === "ranking" && item.status !== "disabled" && !snapshots.some(snapshot => snapshot.source_id === item.source_id))) sources.push({ source_id: attempt.source_id, status: attempt.status, complete_response: false, coverage_truncated: false, entries: 0, retrieved_at: null, data_as_of: null, snapshot_path: `${attempt.source_id}/snapshot.json`, issues: attempt.error ? [attempt.error] : [], retained_last_good: false });
  const index = { schema_version: 1, started_at: now, completed_at: now, purpose: "Ranking collection inputs for review; no publication or inference", sources, attempts };
  const indexPath = join(stateDir, "index.json");
  if (await Bun.file(indexPath).exists()) { const body = await Bun.file(indexPath).text(); await immutable(join(stateDir, "history", `${sha256(body)}-index.json`), body); }
  const body = stableStringify(index); await immutable(join(stateDir, "history", `${sha256(body)}-index.json`), body); await atomicWrite(indexPath, body);
  return { snapshots, attempts, catalogs };
}
