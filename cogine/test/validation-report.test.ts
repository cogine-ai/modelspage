import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aaVariantBase, canonicalKeys, compareReportRows, completeDays, generateReport, meanCompleteShares } from "../scripts/validation/report.js";

const now = "2026-10-26T14:00:00.000Z";
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "modelspage-validation-")); temporary.push(directory);
  async function json(relative: string, value: unknown) {
    const path = join(directory, relative); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value));
    return path;
  }
  const providers = [{ id: "one", name: "One", order: 0, modelsdev_provider: "one" }, { id: "two", name: "Two", order: 1, modelsdev_provider: "two" }];
  await json("inputs/coginework-providers.json", { coginework: { head: "fixture" }, summary: { provider_count: 2 }, providers });
  const result = (models: { id: string }[], status: string) => ({ status, membership_complete: status === "refreshed", reason: status, models: status === "refreshed" ? models : [], listed_model_ids: models.map(m => m.id), fallback: { models }, requests: [], issues: [] });
  const one = await json("refresh/one.json", result([{ id: "alpha" }, { id: "Alpha:free" }, { id: "month" }], "refreshed"));
  const two = await json("refresh/two.json", result([{ id: "beta" }], "requires_auth"));
  await json("refresh/index.json", { results: [{ provider_id: "one", path: one }, { provider_id: "two", path: two }] });
  const model = (id: string, canonical_id: string, release_date = "2026-10-01") => ({ id, name: id, canonical_id, release_date });
  await json("inputs/upstream-latest.json", { status: "success", source: { commit: "fixture" }, providers: [
    { id: "one", models: [model("alpha", "lab/alpha"), model("month", "lab/month", "2026-10")] },
    { id: "two", models: [model("beta", "lab/beta")] },
    { id: "vercel", models: [model("lab/alpha", "lab/alpha"), model("lab/beta", "lab/beta")] },
    { id: "opencode-go", models: [model("alpha", "lab/alpha")] },
  ] });
  await json("sources/vercel-ai-gateway/catalog-public.json", { data: [{ id: "lab/alpha", name: "Alpha" }, { id: "lab/beta", name: "Beta" }] });
  const dates = completeDays(now);
  const snapshots: Record<string, any> = {
    "artificial-analysis": { entries: [
      { source_model_id: "aa-alpha", source_slug: "alpha", value: 80, index_version: 4.3 },
      { source_model_id: "aa-beta", source_slug: "beta", value: 0, index_version: 4.3 },
    ] },
    "vercel-ai-gateway": { entries: dates.flatMap(date => [
      { source_model_id: "Alpha", date, metric: "tokens", value: 10 },
      { source_model_id: "Beta", date, metric: "tokens", value: 90 },
    ]) },
    "opencode-go-free": { entries: dates.map(date => ({ source_model_id: "alpha", date, metric: "tokens", value: 20 })), metadata: { daily_tokens_totals: dates.map(date => ({ date, total_tokens: 100 })) } },
  };
  for (const [id, value] of Object.entries(snapshots)) await json(`sources/${id}/snapshot.json`, { status: "success", complete_response: true, ...value });
  await json("sources/index.json", { sources: Object.keys(snapshots).map(id => ({ source_id: id, snapshot_path: `${id}/snapshot.json` })) });
  return { directory, json, snapshots };
}

describe("all-provider diagnostic report", () => {
  test("common window excludes the current incomplete UTC day; a missing day never becomes zero", () => {
    expect(completeDays(now)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(meanCompleteShares(new Map([["a", 0], ["b", 20]]), ["a", "b"])).toBe(10);
    expect(meanCompleteShares(new Map([["a", 0]]), ["a", "b"])).toBeNull();
    expect(() => completeDays("invalid")).toThrow();
    expect(() => meanCompleteShares(new Map(), [])).toThrow();
  });
  test("semantic version, free/cloud and quantization tokens survive offline slug keys", () => {
    expect(canonicalKeys("lab/claude-sonnet-4.6")).toContain("claude-4-6-sonnet");
    expect(canonicalKeys("lab/model-4-free")).not.toEqual(canonicalKeys("lab/model-4"));
    expect(canonicalKeys("lab/model-4-cloud")).not.toEqual(canonicalKeys("lab/model-4-q4"));
    expect(aaVariantBase("claude-opus-4-6-adaptive", "Claude Opus 4.6 (Max)")).toBe("claude-opus-4-6");
    expect(aaVariantBase("sonar-reasoning", "Sonar Reasoning")).toBeNull();
    expect(aaVariantBase("model-0424-high", "Model 0424 (High)")).toBe("model-0424");
    expect(aaVariantBase("deepseek-v4-flash-vision", "DeepSeek V4 Flash Vision (Max)")).toBeNull();
  });
  test("whole membership survives C/P/N including unknown and unavailable refresh; score zero is known", async () => {
    const { directory } = await fixture();
    const report = await generateReport(directory, join(directory, "out"), now);
    expect(report.summary).toMatchObject({ provider_count: 2, model_rows: 4, latest_refreshed_providers: 1, c_known: 2, p_trial_known: 2, n_day_known: 2 });
    const alpha = report.models.find(row => row.request_model_id === "alpha")!;
    expect(alpha.p_trial_score).toBe(5);
    const beta = report.models.find(row => row.request_model_id === "beta")!;
    expect(beta).toMatchObject({ c_score: 0, p_trial_score: 27, inventory_basis: "packaged_fallback_not_latest" });
    expect(beta.p_source_evidence.openrouter.score).toBeNull();
    expect(report.models.find(row => row.request_model_id === "Alpha:free")).toMatchObject({ canonical_id: null, c_score: null });
    expect(report.models.find(row => row.request_model_id === "month")).toMatchObject({ n_date: "2026-10", n_precision: "month", n_eligible: false });
    for (const provider of report.providers) for (const field of ["c_order", "p_trial_order", "n_order"]) expect([...provider[field]].sort()).toEqual(report.models.filter(row => row.provider_id === provider.id).map(row => row.request_model_id).sort());
    expect([...report.models].sort((a, b) => a.c_global_order_position - b.c_global_order_position).slice(0, 2).map(row => row.request_model_id)).toEqual(["alpha", "beta"]);
    const html = await Bun.file(join(directory, "out/index.html")).text();
    expect(html).toContain("c_global_order_position");
    expect(html).not.toContain("undefined</");
  });
  test("duplicate usage rows fail rather than double-count; incompatible AA index versions do not mix", async () => {
    const { directory, json, snapshots } = await fixture();
    snapshots["vercel-ai-gateway"].entries.push(snapshots["vercel-ai-gateway"].entries[0]);
    await json("sources/vercel-ai-gateway/snapshot.json", { status: "success", complete_response: true, ...snapshots["vercel-ai-gateway"] });
    await expect(generateReport(directory, join(directory, "out"), now)).rejects.toThrow("Duplicate model/day");
    snapshots["vercel-ai-gateway"].entries.pop();
    snapshots["artificial-analysis"].entries[1].index_version = 5;
    await json("sources/vercel-ai-gateway/snapshot.json", { status: "success", complete_response: true, ...snapshots["vercel-ai-gateway"] });
    await json("sources/artificial-analysis/snapshot.json", { status: "success", complete_response: true, ...snapshots["artificial-analysis"] });
    const report = await generateReport(directory, join(directory, "out"), now);
    expect(report.summary.c_known).toBe(0);
    expect(report.issues.some(issue => issue.code === "aa_index_versions_incomparable")).toBe(true);
  });
  test("source-only models remain visible without entering client orders; partial AA cannot create known C", async () => {
    const { directory, json, snapshots } = await fixture();
    const live = await Bun.file(join(directory, "refresh/one.json")).json();
    live.listed_model_ids.push("unsupported-model");
    await json("refresh/one.json", live);
    await json("sources/artificial-analysis/snapshot.json", { ...snapshots["artificial-analysis"], status: "partial", complete_response: false });
    const report = await generateReport(directory, join(directory, "out"), now);
    expect(report.summary).toMatchObject({ model_rows: 5, client_context_model_rows: 4, source_only_model_rows: 1, c_known: 0 });
    expect(report.models.find(row => row.request_model_id === "unsupported-model")).toMatchObject({ included_in_client_context: false, inventory_basis: "live_source_catalog_excluded_by_client" });
    for (const field of ["c_order", "p_trial_order", "n_order"]) expect(report.providers[0]![field]).not.toContain("unsupported-model");
    expect(report.source_associations.filter(row => row.source_id === "artificial-analysis")).toHaveLength(2);
  });
  test("OpenRouter native daily totals are used once, including Other in the denominator", async () => {
    const { directory, json } = await fixture();
    const reference = await Bun.file(join(directory, "inputs/upstream-latest.json")).json();
    reference.providers.push({ id: "openrouter", models: [{ id: "lab/alpha", canonical_id: "lab/alpha", release_date: "2026-10-01" }] });
    await json("inputs/upstream-latest.json", reference);
    const dates = completeDays(now);
    await json("sources/openrouter/snapshot.json", { status: "success", complete_response: true, entries: dates.flatMap(date => [
      { source_model_id: "lab/alpha", date, metric: "tokens", value: 20 },
      { source_model_id: "other", is_aggregate: true, date, metric: "tokens", value: 80 },
    ]), metadata: { daily_tokens_totals: dates.map(date => ({ date, total_tokens: 100 })) } });
    const index = await Bun.file(join(directory, "sources/index.json")).json();
    index.sources.push({ source_id: "openrouter", snapshot_path: "openrouter/snapshot.json" });
    await json("sources/index.json", index);
    const report = await generateReport(directory, join(directory, "out"), now);
    const alpha = report.models.find(row => row.request_model_id === "alpha")!;
    expect(alpha.p_source_scores.openrouter).toBe(20);
    expect(alpha.p_trial_score).toBe(17);
    expect(report.trial_popularity_method.active_sources).toHaveLength(3);
    await json("sources/openrouter/snapshot.json", { status: "success", complete_response: true, entries: dates.map(date => ({ source_model_id: "lab/alpha", date, metric: "tokens", value: 20 })) });
    const noDenominator = await generateReport(directory, join(directory, "out-missing-total"), now, 3);
    const without = noDenominator.models.find(row => row.request_model_id === "alpha")!;
    expect(without.p_source_scores.openrouter).toBeNull();
    expect(without.p_trial_score).toBe(5);
    expect(noDenominator.issues.some(issue => issue.code === "source_daily_denominator_missing")).toBe(true);
    expect(noDenominator.popularity_window_coverage.map(window => window.independent_models)).toEqual([2, 2, 2, 2]);
  });
  test("metric comparison is global and transitive before Provider tie breaking", () => {
    const rows = [0, 1, 2, 3, 4, 5].map(i => ({ request_model_id: `m${i}`, provider_order: i % 2, source_position: i, c_score: i % 3 ? i : null, p_trial_score: i, n_date: "2026-10-01", n_precision: "day" }));
    for (const a of rows) for (const b of rows) for (const c of rows) if (compareReportRows(a, b, "c_score", now) < 0 && compareReportRows(b, c, "c_score", now) < 0) expect(compareReportRows(a, c, "c_score", now)).toBeLessThan(0);
    expect([...rows].sort((a, b) => compareReportRows(a, b, "c_score", now))[0]!.request_model_id).toBe("m5");
  });
});
