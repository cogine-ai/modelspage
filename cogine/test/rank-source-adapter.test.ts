import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAa, collectRankSources, persistSnapshot, rankSourceContentHash, readRankSourceSnapshots, type RankSourceSnapshot } from "../src/adapters/rank-sources.js";
import { atomicWrite, sha256, stableStringify } from "../src/integrity.js";
import { sealRankingInput, type RankingInput } from "../src/ranking-input.js";

const now = "2026-10-27T12:00:00.000Z", next = "2026-10-27T13:00:00.000Z";
const days = Array.from({ length: 7 }, (_, i) => `2026-10-${20 + i}`);
const credentialNames = ["MODELSPAGE_AA_API_KEY", "ARTIFICIAL_ANALYSIS_API_KEY", "AA_API_KEY", "MODELSPAGE_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"];
async function isolated(run: (directory: string) => Promise<void>, auth = true) {
  const directory = await mkdtemp(join(tmpdir(), "modelspage-rank-adapter-"));
  const previous = new Map(credentialNames.map(name => [name, process.env[name]]));
  credentialNames.forEach(name => delete process.env[name]);
  if (auth) { process.env.MODELSPAGE_AA_API_KEY = "fixture-aa-credential"; process.env.MODELSPAGE_OPENROUTER_API_KEY = "fixture-or-credential"; }
  try { await run(directory); }
  finally { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } await rm(directory, { recursive: true, force: true }); }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function fixtureFetcher(options: { updated?: string; aaScore?: number; catalogId?: string; catalogSlug?: string; fail?: boolean } = {}) {
  const urls: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); urls.push(url);
    if (options.fail) return json({}, 503);
    if (url.includes("artificialanalysis.ai/api")) {
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("fixture-aa-credential");
      if (!url.includes("/free")) return json({}, 403);
      const page = new URL(url).searchParams.get("page") === "2" ? 2 : 1;
      return json({ intelligence_index_version: "4.3", tier: "free", pagination: { page, total_pages: 2, has_more: page === 1 }, data: [{ id: `aa-${page}`, slug: `model-${page}`, name: `Model ${page}`, evaluations: { artificial_analysis_intelligence_index: page === 1 ? options.aaScore ?? 55 : null } }] });
    }
    if (url.includes("rankings-daily")) {
      const query = new URL(url).searchParams;
      expect(query.get("start_date")).toBe(days[0]); expect(query.get("end_date")).toBe(days.at(-1)!); expect(query.get("period")).toBe("day");
      return json({ meta: { start_date: days[0], end_date: days.at(-1), as_of: options.updated ?? now, version: "v1" }, data: days.flatMap(date => [{ date, model_permaslug: "model-one", total_tokens: "70" }, { date, model_permaslug: "other", total_tokens: "30" }]) });
    }
    if (url.includes("leaderboard-export")) return json({ dataset: "models", modality: "text", license: "CC-BY-4.0", rows: days.flatMap(date => [
      { name: "Model One", date, metric: "tokens", share_percent: 70, group: "model", modality: "text" },
      { name: "Other", date, metric: "tokens", share_percent: 30, group: "model", modality: "text" },
    ]) });
    if (url.includes("opencode.ai/data")) return json({ updatedAt: options.updated ?? now, leaderboard: { pastWeek: [{ model: "model-one", tokens: "490", rank: 1 }], pastDay: [{ model: "model-one", tokens: "70", rank: 1 }] }, dailyTokens: days.map(date => ({ date, total: "100", models: { "model-one": "70", Other: "30" } })) });
    if (url.includes("openrouter.ai/api/v1/models")) return json({ data: [{ id: options.catalogId ?? "maker/model", name: "Model One", canonical_slug: options.catalogSlug ?? "model-one" }], total_count: 1, links: { next: null } });
    if (url.includes("ai-gateway.vercel.sh/v1/models")) return json({ data: [{ id: "maker/model", name: "Model One", owned_by: "maker" }] });
    throw new Error("Unexpected fixture URL");
  }) as typeof fetch;
  return { fetcher, urls };
}

describe("reusable ranking source adapter", () => {
  test("one collector produces all four complete sources, native totals and exact catalogs with a fixed UTC clock", () => isolated(async directory => {
    const fixture = fixtureFetcher();
    const result = await collectRankSources({ stateDir: directory, now, fetcher: fixture.fetcher });
    expect(result.snapshots.map(source => [source.source_id, source.entries.length])).toEqual([
      ["artificial-analysis", 2], ["openrouter", 14], ["vercel-ai-gateway", 14], ["opencode-go-free", 16],
    ]);
    expect(result.snapshots.every(source => source.status === "success" && source.complete_response && source.retrieved_at === now && source.attempted_at === now)).toBe(true);
    expect(result.attempts).toHaveLength(6);
    expect(result.attempts.every(attempt => attempt.status === "success" && attempt.changed && !attempt.retained_last_good)).toBe(true);
    const aa = result.snapshots[0]!;
    expect(aa.metadata.pages).toBe(2); expect(aa.metadata.full_endpoint_forbidden).toBe(true); expect(aa.entries[1]!.value).toBeNull();
    const router = result.snapshots[1]!;
    expect(router.window.start).toBe(days[0]); expect(router.window.end).toBe(days.at(-1)!);
    expect((router.metadata.daily_tokens_totals as any[]).every(day => day.total_tokens === "100")).toBe(true);
    expect((result.snapshots[3]!.metadata.daily_tokens_totals as any[]).every(day => day.total_tokens === "100" && day.rounding_delta_tokens === "0" && day.model_ids.includes("Other"))).toBe(true);
    expect(result.snapshots[2]!.data_as_of).toBeNull();
    expect(result.catalogs.map(catalog => [catalog.source_id, catalog.entries[0]!.id, catalog.retrieved_at])).toEqual([["openrouter", "maker/model", now], ["vercel-ai-gateway", "maker/model", now]]);
    expect((await readRankSourceSnapshots(directory, { publicOnly: true })).map(source => source.source_id)).toEqual(["openrouter", "vercel-ai-gateway"]);
    for (const source of result.snapshots) for (const raw of source.raw_files) expect(sha256(await Bun.file(join(directory, raw.path)).text())).toBe(raw.sha256);
    expect(fixture.urls.filter(url => url.includes("/free"))).toHaveLength(2);
  }));

  test("unchanged native facts retain durable snapshots and catalog bytes despite new observations and source as_of", () => isolated(async directory => {
    const first = await collectRankSources({ stateDir: directory, now, fetcher: fixtureFetcher().fetcher });
    const bodies = await Promise.all(first.snapshots.map(source => Bun.file(join(directory, source.source_id, "last-good.json")).text()));
    const catalogs = stableStringify(first.catalogs);
    const second = await collectRankSources({ stateDir: directory, now: next, fetcher: fixtureFetcher({ updated: next }).fetcher });
    expect(second.attempts.every(attempt => attempt.status === "not_modified" && !attempt.changed && attempt.retained_last_good && attempt.attempted_at === next)).toBe(true);
    expect(stableStringify(second.catalogs)).toBe(catalogs);
    expect(await Promise.all(first.snapshots.map(source => Bun.file(join(directory, source.source_id, "last-good.json")).text()))).toEqual(bodies);
    expect(second.snapshots.every(source => source.retrieved_at === now)).toBe(true);
    const changed = await collectRankSources({ stateDir: directory, sourceIds: ["artificial-analysis"], now: next, fetcher: fixtureFetcher({ aaScore: 56 }).fetcher });
    expect(changed.attempts[0]!.changed).toBe(true);
    expect(changed.snapshots[0]!.entries[0]!.value).toBe(56);
    expect(changed.snapshots[0]!.retrieved_at).toBe(next);
  }));

  test("reviewed usage is applied before cache comparison, preserving prior clocks and ciphertext when data and policy are unchanged", () => isolated(async directory => {
    const usageOverrides: Record<string, RankSourceSnapshot["usage"]> = {
      "artificial-analysis": { collection: "allowed", redistribution: "unverified", evidence: "Current reviewed AA internal-use policy" },
      "openrouter": { collection: "allowed", redistribution: "allowed", evidence: "Current reviewed rankings dataset permission, not a catalog grant" },
      "vercel-ai-gateway": { collection: "allowed", redistribution: "allowed", evidence: "Current reviewed leaderboard dataset permission, not a catalog grant" },
      "opencode-go-free": { collection: "unverified", redistribution: "unverified", evidence: "Current reviewed explicit diagnostic-use policy" },
    };
    const first = await collectRankSources({ stateDir: join(directory, "first"), now, usageOverrides, fetcher: fixtureFetcher().fetcher });
    expect(first.snapshots.every(source => stableStringify(source.usage) === stableStringify(usageOverrides[source.source_id]))).toBe(true);
    expect(first.catalogs.every(catalog => catalog.usage.redistribution === "unverified" && catalog.usage.collection === "diagnostic_only")).toBe(true);
    const second = await collectRankSources({ stateDir: join(directory, "second"), now: next, usageOverrides, previousSnapshots: first.snapshots, previousCatalogs: first.catalogs, fetcher: fixtureFetcher({ updated: next }).fetcher });
    expect(second.attempts.every(attempt => attempt.status === "not_modified" && !attempt.changed && attempt.retained_last_good)).toBe(true);
    expect(stableStringify(second.snapshots)).toBe(stableStringify(first.snapshots));
    expect(stableStringify(second.catalogs)).toBe(stableStringify(first.catalogs));
    for (const source of first.snapshots) expect(await Bun.file(join(directory, "second", source.source_id, "last-good.json")).text()).toBe(await Bun.file(join(directory, "first", source.source_id, "last-good.json")).text());
    const input = (snapshots: RankSourceSnapshot[], catalogs: typeof first.catalogs): RankingInput => ({ schema_version: 1, evaluation_date: now.slice(0, 10), policy: { id: "test-observed-policy", weights_status: "accepted", window_days: 7, weights: { openrouter: 0.6, "vercel-ai-gateway": 0.3, "opencode-go-free": 0.1 } }, snapshots, catalogs });
    const key = "ab".repeat(32), encrypted = sealRankingInput(input(first.snapshots, first.catalogs), key);
    expect(stableStringify(sealRankingInput(input(second.snapshots, second.catalogs), key, encrypted))).toBe(stableStringify(encrypted));
    const changed = await collectRankSources({ stateDir: join(directory, "second"), sourceIds: ["artificial-analysis"], now: next, usageOverrides: { ...usageOverrides, "artificial-analysis": { ...usageOverrides["artificial-analysis"]!, evidence: "Current reviewed AA policy v2" } }, fetcher: fixtureFetcher().fetcher });
    expect(changed.attempts[0]!.status).toBe("success"); expect(changed.attempts[0]!.changed).toBe(true);
    expect(changed.snapshots[0]!.entries).toEqual(first.snapshots[0]!.entries); expect(changed.snapshots[0]!.usage.evidence).toBe("Current reviewed AA policy v2");
    expect(sealRankingInput(input(changed.snapshots, changed.catalogs), key, encrypted).plaintext_sha256).not.toBe(encrypted.plaintext_sha256);
  }));

  test("failed, HTTP304, authentication-missing and disabled attempts retain prior facts without freshening them", () => isolated(async directory => {
    const first = await collectRankSources({ stateDir: directory, now, fetcher: fixtureFetcher().fetcher });
    const expected = stableStringify(first.snapshots);
    const failed = await collectRankSources({ stateDir: directory, now: next, fetcher: fixtureFetcher({ fail: true }).fetcher });
    expect(failed.attempts.every(attempt => attempt.status === "failed" && attempt.retained_last_good)).toBe(true);
    expect(stableStringify(failed.snapshots)).toBe(expected);
    const notModified = await collectRankSources({ stateDir: directory, now: next, fetcher: (async () => new Response(null, { status: 304 })) as unknown as typeof fetch });
    expect(notModified.attempts.every(attempt => attempt.status === "not_modified")).toBe(true);
    expect(stableStringify(notModified.snapshots)).toBe(expected);
    credentialNames.forEach(name => delete process.env[name]);
    const noAuth = await collectRankSources({ stateDir: directory, sourceIds: ["artificial-analysis", "openrouter"], includeCatalogs: false, now: next, fetcher: (async () => { throw new Error("Must not request an authenticated source without a key"); }) as unknown as typeof fetch });
    expect(noAuth.attempts.every(attempt => attempt.status === "authentication_required" && attempt.retained_last_good)).toBe(true);
    expect(stableStringify(noAuth.snapshots)).toBe(expected);
    const disabled = await collectRankSources({ stateDir: directory, sourceIds: ["openrouter"], disabledSourceIds: ["openrouter"], now: next });
    expect(disabled.attempts[0]!.status).toBe("disabled"); expect(stableStringify(disabled.snapshots)).toBe(expected);
    const index = await Bun.file(join(directory, "index.json")).json();
    for (const source of index.sources) expect(await Bun.file(join(directory, source.snapshot_path)).exists()).toBe(true);
  }));

  test("missing auth cannot substitute sorted catalog positions for daily token evidence", () => isolated(async directory => {
    let calls = 0;
    const result = await collectRankSources({ stateDir: directory, sourceIds: ["artificial-analysis", "openrouter"], now, includeCatalogs: false, fetcher: (async () => { calls++; return json({}); }) as unknown as typeof fetch });
    expect(calls).toBe(0); expect(result.snapshots).toHaveLength(0); expect(result.attempts.every(attempt => attempt.status === "authentication_required")).toBe(true);
    const emptyDisabled = await collectRankSources({ stateDir: join(directory, "disabled"), sourceIds: ["openrouter"], disabledSourceIds: ["openrouter"], now });
    expect(emptyDisabled.snapshots).toHaveLength(0); expect((await Bun.file(join(directory, "disabled/index.json")).json()).sources).toHaveLength(0);
  }, false));

  test("credential echo is rejected before raw persistence, including JSON escapes", () => isolated(async directory => {
    const body = '{"leak":"fixture\\u002daa-credential"}';
    const source = await collectAa(directory, { now, fetcher: (async () => new Response(body, { headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
    expect(source.status).toBe("failed"); expect(source.entries).toHaveLength(0); expect(source.raw_files).toHaveLength(0);
    expect(stableStringify(source)).not.toContain("fixture-aa-credential");
    expect((await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory }))).length).toBe(0);
    const malformed = await collectAa(directory, { now, fetcher: (async () => new Response(body.slice(0, -1) + ",}", { headers: { "content-type": "application/json" } })) as unknown as typeof fetch });
    expect(malformed.issues).toEqual(["Error: Source response is invalid JSON; response body discarded"]);
    expect(malformed.raw_files).toHaveLength(0);
  }));

  test("AA partial pagination and OR invalid windows cannot overwrite a valid snapshot", () => isolated(async directory => {
    const first = await collectRankSources({ stateDir: directory, sourceIds: ["artificial-analysis", "openrouter"], now, includeCatalogs: false, fetcher: fixtureFetcher().fetcher });
    const faulty = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("artificialanalysis")) return json({ intelligence_index_version: "4.3", tier: "free", pagination: { page: 1, total_pages: 2, has_more: false }, data: [{ id: "partial", slug: "partial", name: "Partial", evaluations: { artificial_analysis_intelligence_index: 1 } }] });
      return json({ meta: { start_date: days[0], end_date: days.at(-1), as_of: now, version: "v1" }, data: [{ date: days[0], model_permaslug: "model-one", total_tokens: "7" }] });
    }) as typeof fetch;
    const result = await collectRankSources({ stateDir: directory, sourceIds: ["artificial-analysis", "openrouter"], now: next, includeCatalogs: false, fetcher: faulty });
    expect(result.attempts.every(attempt => attempt.status === "partial" && attempt.retained_last_good)).toBe(true);
    expect(stableStringify(result.snapshots)).toBe(stableStringify(first.snapshots));
  }));

  test("prior encrypted snapshots and historical exact catalogs seed a fresh state without losing identity generations", () => isolated(async directory => {
    const old = await collectRankSources({ stateDir: join(directory, "old"), now, fetcher: fixtureFetcher().fetcher });
    const fresh = await collectRankSources({ stateDir: join(directory, "fresh"), sourceIds: ["openrouter"], previousSnapshots: old.snapshots, previousCatalogs: old.catalogs, now: next, fetcher: fixtureFetcher({ catalogId: "maker/renamed-model" }).fetcher });
    expect(fresh.snapshots).toHaveLength(4);
    expect(fresh.catalogs.filter(catalog => catalog.source_id === "openrouter").flatMap(catalog => catalog.entries.map(entry => entry.id)).sort()).toEqual(["maker/model", "maker/renamed-model"]);
    expect(fresh.catalogs.find(catalog => catalog.source_id === "vercel-ai-gateway")!.retrieved_at).toBe(now);
    const failed = await collectRankSources({ stateDir: join(directory, "fresh"), sourceIds: ["openrouter"], now: next, fetcher: fixtureFetcher({ fail: true }).fetcher });
    expect(stableStringify(failed.catalogs)).toBe(stableStringify(fresh.catalogs));
  }));

  test("legacy raw identity catalogs retain exact names and unknown observation time", () => isolated(async directory => {
    const body = JSON.stringify({ data: [{ id: "maker/model:free", name: "Exact Name (Preview)", canonical_slug: "model-20261020" }], total_count: 1, links: { next: null } });
    await atomicWrite(join(directory, "openrouter/models-top-weekly-diagnostic.json"), body);
    const result = await collectRankSources({ stateDir: directory, sourceIds: [], now, includeCatalogs: false });
    expect(result.catalogs).toHaveLength(1); expect(result.catalogs[0]!.retrieved_at).toBeNull(); expect(result.catalogs[0]!.sha256).toBe(sha256(body));
    expect(result.catalogs[0]!.entries[0]).toEqual({ id: "maker/model:free", name: "Exact Name (Preview)", canonical_slug: "model-20261020" });
  }));

  test("legacy diagnostic usage and production unverified usage are accepted without raising permissions", () => isolated(async directory => {
    const source: RankSourceSnapshot = { schema_version: 1, source_id: "artificial-analysis", attempted_at: now, retrieved_at: now, data_as_of: null, data_as_of_precision: null, status: "success", complete_response: true, coverage_truncated: false, scope: "test", cutoff: "test", window: { start: null, end: null, label: "test" }, usage: { collection: "unverified", redistribution: "unverified", evidence: "test" }, authentication_provided: false, endpoints: [], raw_files: [], entries: [{ source_model_id: "aa", metric: "index", value: 5, value_unit: "points" }], issues: [], metadata: {} };
    await persistSnapshot(directory, source);
    expect((await readRankSourceSnapshots(directory))[0]!.usage.collection).toBe("unverified"); expect(await readRankSourceSnapshots(directory, { publicOnly: true })).toHaveLength(0);
    const hash = rankSourceContentHash(source);
    expect(rankSourceContentHash({ ...source, data_as_of: next, retrieved_at: next })).toBe(hash);
    expect(rankSourceContentHash({ ...source, entries: [{ ...source.entries[0]!, value: 6 }] })).not.toBe(hash);
    await persistSnapshot(directory, { ...source, usage: { collection: "disabled", redistribution: "disabled", evidence: "Explicitly disabled by current reviewed policy" } });
    expect((await readRankSourceSnapshots(directory))[0]!.usage.collection).toBe("disabled"); expect(await readRankSourceSnapshots(directory, { publicOnly: true })).toHaveLength(0);
  }));
});
