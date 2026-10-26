import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { atomicWrite, sha256, stableStringify } from "../../src/integrity.js";

type Status = "success" | "authentication_required" | "failed" | "partial";
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
  usage: { collection: "allowed" | "diagnostic_only"; redistribution: "allowed" | "unverified"; evidence: string };
  authentication_provided: boolean;
  endpoints: string[];
  raw_files: { path: string; sha256: string; bytes: number }[];
  entries: RankSourceEntry[];
  issues: string[];
  metadata: Record<string, unknown>;
};

const iso = () => new Date().toISOString();
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
async function getJson(url: string, headers: Record<string, string> = {}) {
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
  const status = Number(statusText);
  if (status !== 200) throw new HttpError(status);
  const contentType = contentTypeParts.join(":");
  if (!contentType.toLowerCase().includes("json")) throw new Error(`Expected JSON, received ${contentType || "no content type"}`);
  const body = bodyWithMeta.slice(0, marker);
  assertNoCredentialEcho(body);
  const json = JSON.parse(body) as unknown;
  assertNoCredentialEcho(json);
  return { body, json, retrievedAt: iso() };
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
export async function persistSnapshot(outDir: string, snapshot: RankSourceSnapshot) {
  assertNoCredentialEcho(snapshot);
  const sourceDir = join(outDir, snapshot.source_id);
  const previousPath = join(sourceDir, "snapshot.json"); const goodPath = join(sourceDir, "last-good.json");
  const previousFile = Bun.file(previousPath);
  const goodFile = Bun.file(goodPath);
  if (await previousFile.exists()) {
    const previousBody = await previousFile.text(); const previous = JSON.parse(previousBody) as RankSourceSnapshot;
    assertNoCredentialEcho(previous);
    await atomicWrite(join(sourceDir, "history", `${sha256(previousBody)}.json`), previousBody);
    if (!await goodFile.exists() && previous.status === "success" && previous.complete_response) await atomicWrite(goodPath, previousBody);
  }
  if (!(snapshot.status === "success" && snapshot.complete_response) && await goodFile.exists()) {
    const lastGood = await goodFile.json() as RankSourceSnapshot;
    snapshot.metadata.last_good_retained = { path: `${snapshot.source_id}/last-good.json`, retrieved_at: lastGood.retrieved_at, data_as_of: lastGood.data_as_of, entries: lastGood.entries.length };
  }
  const body = stableStringify(snapshot);
  assertNoCredentialEcho(body);
  await atomicWrite(join(sourceDir, "history", `${sha256(body)}.json`), body);
  if (snapshot.status === "success" && snapshot.complete_response) await atomicWrite(goodPath, body);
  await atomicWrite(previousPath, body);
}
function base(sourceId: string, options: Pick<RankSourceSnapshot, "scope" | "cutoff" | "usage">): RankSourceSnapshot {
  return { schema_version: 1, source_id: sourceId, attempted_at: iso(), retrieved_at: null, data_as_of: null, data_as_of_precision: null, status: "failed", complete_response: false, coverage_truncated: false, scope: options.scope, cutoff: options.cutoff, usage: options.usage, authentication_provided: false, endpoints: [], raw_files: [], entries: [], issues: [], metadata: {}, window: { start: null, end: null, label: "Source has not supplied explicit boundaries" } };
}
function fail(snapshot: RankSourceSnapshot, error: unknown) {
  snapshot.status = error instanceof HttpError && [401, 403].includes(error.status) && snapshot.authentication_provided ? "authentication_required" : snapshot.entries.length ? "partial" : "failed";
  snapshot.complete_response = false;
  snapshot.issues.push(safeMessage(error));
  if (error instanceof HttpError) snapshot.metadata.http_status = error.status;
}

export async function collectAa(outDir: string): Promise<RankSourceSnapshot> {
  const snapshot = base("artificial-analysis", { scope: "AA published language-model Intelligence Index, preserving each AA model/effort record", cutoff: "AA catalog coverage; missing score is unknown, not zero", usage: { collection: "diagnostic_only", redistribution: "unverified", evidence: "https://artificialanalysis.ai/data-api and Data Platform Terms: API access alone does not establish public JSON redistribution rights." } });
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
    try { first = await getJson(endpoint, { "x-api-key": key }); }
    catch (error) {
      if (!(error instanceof HttpError) || error.status !== 403) throw error;
      snapshot.metadata.full_endpoint_forbidden = true;
      endpoint = "https://artificialanalysis.ai/api/v2/language/models/free";
      first = await getJson(endpoint, { "x-api-key": key });
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
      result = await getJson(`${endpoint}?page=${page}`, { "x-api-key": key });
    }
    if (!snapshot.entries.length) throw new Error("AA catalog is empty");
    snapshot.metadata.intelligence_index_version = version;
    snapshot.metadata.pages = page;
    snapshot.status = "success"; snapshot.complete_response = true;
    snapshot.issues.push("AA API version contains major.minor only; do not manufacture a patch version or merge independent reasoning records.");
  } catch (error) { fail(snapshot, error); }
  return snapshot;
}

export async function collectVercel(outDir: string): Promise<RankSourceSnapshot> {
  const url = "https://vercel.com/api/ai/leaderboard-export?dataset=models&modality=text";
  const snapshot = base("vercel-ai-gateway", { scope: "Vercel AI Gateway public text-model daily usage shares, not whole-market calls", cutoff: "Published top model series plus Other; long-tail individual shares may be absent", usage: { collection: "allowed", redistribution: "allowed", evidence: "https://vercel.com/changelog/open-data-and-shareable-charts-for-ai-gateway-leaderboards — public JSON/CSV, CC BY 4.0 with attribution and changes indicated." } });
  snapshot.endpoints.push(url);
  try {
    const result = await getJson(url);
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

export async function collectOpenCode(outDir: string): Promise<RankSourceSnapshot> {
  const url = "https://opencode.ai/data/index.json";
  const snapshot = base("opencode-go-free", { scope: "OpenCode public site Go/Free sample per official stats source, not all Zen/BYOK traffic", cutoff: "Native leaderboard top 18 and selected daily chart series plus Other; absent individual tail is not zero", usage: { collection: "diagnostic_only", redistribution: "unverified", evidence: "https://opencode.ai/data methodology/citation plus official stats source ed74ec82ce1fe3a36da6c0815a935473ef4bb0fb; endpoint-specific redistribution terms not established." } });
  snapshot.endpoints.push(url);
  try {
    const result = await getJson(url);
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

export async function collectOpenRouter(outDir: string): Promise<RankSourceSnapshot> {
  const key = credential(["MODELSPAGE_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"]);
  const snapshot = base("openrouter", { scope: key ? "OpenRouter public rankings dataset, not account activity" : "One unauthenticated public model-catalog diagnostic with native top-weekly sort", cutoff: key ? "Official selected time bucket top 50 plus Other; individual tail unknown" : "Complete model catalog does not establish per-item weekly usage coverage", usage: { collection: "diagnostic_only", redistribution: key ? "allowed" : "unverified", evidence: key ? "https://openrouter.ai/docs/api/api-reference/datasets/daily-token-totals-for-top-50-models — CC BY 4.0, citation and meta retained." : "Public /models endpoint usage terms remain unverified; diagnostic only, production configuration unchanged." } });
  snapshot.authentication_provided = !!key;
  try {
    if (key) {
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const start = new Date(today); start.setUTCDate(start.getUTCDate() - 7);
      const end = new Date(today); end.setUTCDate(end.getUTCDate() - 1);
      const startDate = start.toISOString().slice(0, 10); const endDate = end.toISOString().slice(0, 10);
      const url = `https://openrouter.ai/api/v1/datasets/rankings-daily?start_date=${startDate}&end_date=${endDate}&period=day&modality=text`;
      snapshot.endpoints.push(url);
      const result = await getJson(url, { Authorization: `Bearer ${key}` });
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
      const result = await getJson(url);
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

async function main() {
  const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { "out-dir": { type: "string" }, only: { type: "string" } } });
  const outDir = resolve(values["out-dir"] ?? ".modelspage/full-validation/sources");
  const startedAt = iso();
  const collectors = { "artificial-analysis": collectAa, "vercel-ai-gateway": collectVercel, "opencode-go-free": collectOpenCode, openrouter: collectOpenRouter };
  const selected = values.only ? values.only.split(",") : Object.keys(collectors);
  if (selected.some(name => !(name in collectors))) throw new Error("Unknown --only source ID");
  const fresh = await Promise.all(selected.map(name => collectors[name as keyof typeof collectors](outDir)));
  for (const snapshot of fresh) await persistSnapshot(outDir, snapshot);
  const snapshots = [...fresh];
  for (const name of Object.keys(collectors).filter(name => !selected.includes(name))) {
    const file = Bun.file(join(outDir, name, "snapshot.json"));
    if (await file.exists()) snapshots.push(await file.json() as RankSourceSnapshot);
  }
  snapshots.sort((a, b) => a.source_id.localeCompare(b.source_id));
  const index = { schema_version: 1, started_at: startedAt, completed_at: iso(), purpose: "Local diagnostic validation only; no production source configuration or eligibility changed", sources: snapshots.map(snapshot => ({ source_id: snapshot.source_id, status: snapshot.status, complete_response: snapshot.complete_response, coverage_truncated: snapshot.coverage_truncated, entries: snapshot.entries.length, retrieved_at: snapshot.retrieved_at, data_as_of: snapshot.data_as_of, snapshot_path: `${snapshot.source_id}/snapshot.json`, issues: snapshot.issues })) };
  assertNoCredentialEcho(index);
  const indexFile = Bun.file(join(outDir, "index.json"));
  if (await indexFile.exists()) {
    const body = await indexFile.text(); assertNoCredentialEcho(body);
    await atomicWrite(join(outDir, "history", `${sha256(body)}-index.json`), body);
  }
  await atomicWrite(join(outDir, "history", `${sha256(stableStringify(index))}-index.json`), stableStringify(index));
  await atomicWrite(join(outDir, "index.json"), stableStringify(index));
  console.log(stableStringify(index).trim());
}
if (import.meta.main) main().catch(error => { console.error(safeMessage(error)); process.exitCode = 1; });
