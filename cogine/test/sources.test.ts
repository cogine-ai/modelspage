import { describe, expect, test } from "bun:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fetchOpenRouter, OpenRouterConfig, parseOpenRouterPages, validateOpenRouterSnapshot, type OpenRouterSnapshot } from "../src/adapters/openrouter.js";
import { releasePrecision } from "../src/adapters/upstream.js";
import { collectOpenRouter } from "../src/collect.js";
import { requestJson } from "../src/request.js";
import { stableStringify } from "../src/integrity.js";

const configuration = OpenRouterConfig.parse(await Bun.file("cogine/fixtures/openrouter-config.json").json());
const page = await Bun.file("cogine/fixtures/openrouter-page.json").json();
const previous: OpenRouterSnapshot = await Bun.file("cogine/fixtures/openrouter-snapshot.json").json();
const now = "2026-10-26T00:00:00Z";
function mock(value: unknown, status = 200, headers: Record<string, string> = {}): typeof fetch { return (async () => new Response(status === 304 ? null : JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } })) as unknown as typeof fetch; }

describe("OpenRouter source semantics and completeness", () => {
  test("preserves exact IDs, punctuation, source order and unknown item coverage", () => {
    const result = parseOpenRouterPages([page], configuration);
    expect(result.total).toBe(2);
    expect(result.entries).toEqual([{ source_model_id: "example-lab/model-v1", position: 1, ranking_eligible: true }, { source_model_id: "example-lab/model-v2:free", position: 2, ranking_eligible: false }]);
    expect(result.entries[0]).not.toHaveProperty("tokens");
  });
  test("rejects truncated, duplicate, empty and changing-total snapshots", () => {
    expect(() => parseOpenRouterPages([{ ...page, total_count: 3 }], configuration)).toThrow("Incomplete");
    expect(() => parseOpenRouterPages([{ ...page, links: { next: "/api/v1/models?offset=2" } }], configuration)).toThrow("Incomplete");
    expect(() => parseOpenRouterPages([{ data: [page.data[0], page.data[0]], total_count: 2, links: { next: null } }], configuration)).toThrow("Duplicate");
    expect(() => parseOpenRouterPages([{ data: [], total_count: 0, links: { next: null } }], configuration)).toThrow("Empty");
    expect(() => parseOpenRouterPages([{ data: [page.data[0]], total_count: 2, links: { next: "/next" } }, { data: [page.data[1]], total_count: 3, links: { next: null } }], configuration)).toThrow("Total changed");
  });
  test("stored snapshots cannot claim completeness with missing/duplicate identities", () => {
    expect(() => validateOpenRouterSnapshot({ ...previous, entries: [previous.entries[0]] })).toThrow("incomplete");
    expect(() => validateOpenRouterSnapshot({ ...previous, entries: [previous.entries[0], previous.entries[0]] })).toThrow("unique");
    expect(() => validateOpenRouterSnapshot({ ...previous, entries: [{ ...previous.entries[0], position: 99 }, previous.entries[1]] })).toThrow("contiguous");
  });
  test("follows same-scope pagination, validates total and terminal condition", async () => {
    const first = { data: [page.data[0]], total_count: 2, links: { next: "https://openrouter.ai/api/v1/models?sort=top-weekly&output_modalities=all&offset=1&limit=1" } };
    const second = { data: [page.data[1]], total_count: 2, links: { next: null } };
    const urls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => { urls.push(String(url)); return mock(urls.length === 1 ? first : second)(url); }) as unknown as typeof fetch;
    const result = await fetchOpenRouter(configuration, { now, fetcher, sleep: async () => {} });
    expect(result.source.status).toBe("success");
    expect(result.source.complete).toBe(true);
    expect(result.pagination.pages).toBe(2);
    expect(result.entries[1]?.position).toBe(2);
    expect(result.source.data_as_of).toBeNull();
    expect(result.source.window).toEqual({ start: null, end: null });
  });
  test("partial and failed attempts retain last-good entries and real timestamp", async () => {
    const partial = await fetchOpenRouter(configuration, { now, previous, fetcher: mock({ ...page, total_count: 99 }) });
    expect(partial.source.status).toBe("partial");
    expect(partial.entries).toEqual(previous.entries);
    expect(partial.source.retrieved_at).toBe(previous.source.retrieved_at);
    expect(partial.retained_last_good).toBe(true);
    const failed = await fetchOpenRouter(configuration, { now, previous, fetcher: mock({}, 401) });
    expect(failed.source.status).toBe("failed");
    expect(failed.entries).toEqual(previous.entries);
    expect(failed.source.retrieved_at).toBe(previous.source.retrieved_at);
  });
  test("rejects cross-origin or changed-scope pagination without following it", async () => {
    let requests = 0;
    const fetcher = (async () => { requests++; return new Response(JSON.stringify({ ...page, links: { next: "https://evil.invalid/api/v1/models" } }), { headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
    const result = await fetchOpenRouter(configuration, { now, fetcher });
    expect(requests).toBe(1);
    expect(result.source.status).toBe("partial");
    expect(result.entries).toEqual([]);
  });
  test("disabled source makes no network requests; collection and redistribution are separate", async () => {
    const result = await fetchOpenRouter({ ...configuration, enabled: false }, { now, fetcher: (async () => { throw new Error("Unexpected network"); }) as unknown as typeof fetch });
    expect(result.source.status).toBe("disabled");
    const unverified = { ...configuration, usage: { ...configuration.usage, redistribution: "unverified" as const } };
    expect((await fetchOpenRouter(unverified, { now, fetcher: mock(page) })).source.usage.redistribution).toBe("unverified");
  });
  test("304 preserves input timestamp and durable last-good state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "modelspage-collect-"));
    const statePath = path.join(directory, "state.json");
    const prior = { ...previous, etag: '"fixture"' };
    await Bun.write(statePath, stableStringify(prior));
    try {
      const result = await fetchOpenRouter(configuration, { now, previous: prior, fetcher: mock(null, 304) });
      expect(result.source.status).toBe("not_modified");
      expect(result.source.retrieved_at).toBe(prior.source.retrieved_at);
      // Default checked-in config disables collection. The attempt still cannot replace old state.
      await collectOpenRouter({ now, statePath, reportPath: path.join(directory, "report.json") });
      expect(await Bun.file(statePath).text()).toBe(stableStringify(prior));
      const failed = await collectOpenRouter({ now, probe: true, statePath, reportPath: path.join(directory, "report.json"), fetcher: mock({}, 401) });
      expect(failed.source.status).toBe("failed");
      expect(await Bun.file(statePath).text()).toBe(stableStringify(prior));
      expect((await Bun.file(path.join(directory, "report.json")).json()).source.status).toBe("failed");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test("unchanged response bytes preserve true source freshness without ETag", async () => {
    const first = await fetchOpenRouter(configuration, { now, fetcher: mock(page) });
    const second = await fetchOpenRouter(configuration, { now: "2026-10-27T00:00:00Z", previous: first, fetcher: mock(page) });
    expect(second.source.status).toBe("not_modified");
    expect(second.source.retrieved_at).toBe(first.source.retrieved_at);
    expect(second.source.data_as_of).toBeNull();
  });
  test("irrelevant response fields do not create data changes or replace durable source time/hash", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "modelspage-unchanged-"));
    const statePath = path.join(directory, "state.json");
    const reportPath = path.join(directory, "report.json");
    try {
      await Bun.write(path.join(directory, "cogine/config/openrouter.json"), JSON.stringify(configuration));
      const first = await fetchOpenRouter(configuration, { now: "2026-10-25T00:00:00Z", fetcher: mock(page) });
      const bytes = stableStringify(first);
      await Bun.write(statePath, bytes);
      const changedRaw = { ...page, unused_metadata: "new irrelevant value", data: page.data.map((entry: { id: string }) => ({ ...entry, unused_property: "different wire response" })) };
      const next = await collectOpenRouter({ root: directory, now, statePath, reportPath, fetcher: mock(changedRaw) });
      expect(next.source.status).toBe("not_modified");
      expect(next.entries).toEqual(first.entries);
      expect(next.source.retrieved_at).toBe(first.source.retrieved_at);
      expect(next.source.sha256).toBe(first.source.sha256);
      expect(await Bun.file(statePath).text()).toBe(bytes);
      expect(await Bun.file(reportPath).json()).toMatchObject({ attempted_at: now, source: { status: "not_modified" } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test("changed IDs, source order or reviewed item eligibility still produce a changed snapshot", async () => {
    const first = await fetchOpenRouter(configuration, { now: "2026-10-25T00:00:00Z", fetcher: mock(page) });
    const cases = [
      { config: configuration, page: { ...page, data: [...page.data].reverse() } },
      { config: configuration, page: { ...page, data: [{ id: "example-lab/a-different-version" }, page.data[1]] } },
      { config: { ...configuration, ranked_ids: [], ranking_evidence: "" }, page },
    ];
    for (const current of cases) {
      const next = await fetchOpenRouter(current.config, { now, previous: first, fetcher: mock(current.page) });
      expect(next.source.status).toBe("success");
      expect(next.entries).not.toEqual(first.entries);
      expect(next.source.retrieved_at).toBe(now);
    }
  });
});

test("shared request governance retries rate limits and rejects non-JSON", async () => {
  let attempts = 0;
  const pauses: number[] = [];
  const result = await requestJson("https://example.invalid/source", { fetcher: (async () => { attempts++; return attempts === 1 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : new Response('{"data":[]}', { headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch, sleep: async (ms) => { pauses.push(ms); } });
  expect(attempts).toBe(2);
  expect(pauses).toEqual([2000]);
  expect(result.status).toBe("success");
  await expect(requestJson("https://example.invalid/source", { fetcher: (async () => new Response("html", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch })).rejects.toThrow("application/json");
});

test("date precision is preserved and invalid calendar days rejected", () => {
  expect(releasePrecision("2026")).toBe("year");
  expect(releasePrecision("2026-02")).toBe("month");
  expect(releasePrecision("2026-02-28")).toBe("day");
  expect(releasePrecision("2026-02-30")).toBeUndefined();
  expect(releasePrecision("2026-99-99")).toBeUndefined();
});
