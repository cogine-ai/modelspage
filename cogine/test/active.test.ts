import { expect, test } from "bun:test";
import { fetchCurrentRelease } from "../src/active.js";
import { seal } from "./contract-fixture.js";

const quickReads = { sleep: async () => {}, timeoutMs: 100 };

test("production seed verifies the complete active catalog; first 404 alone means no prior input", async () => {
  const release = seal();
  const fetcher = (async (url: URL) => new Response(url.pathname.endsWith("manifest.json") ? JSON.stringify(release.manifest) : release.catalog, { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  expect((await fetchCurrentRelease("https://example.invalid", fetcher))!.bundle).toEqual(release.bundle);
  const missing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
  expect(await fetchCurrentRelease("https://example.invalid", missing)).toBeNull();
  const failed = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  await expect(fetchCurrentRelease("https://example.invalid", failed, quickReads)).rejects.toThrow("503");
  const corrupt = (async (url: URL) => new Response(url.pathname.endsWith("manifest.json") ? JSON.stringify(release.manifest) : "{}")) as unknown as typeof fetch;
  await expect(fetchCurrentRelease("https://example.invalid", corrupt)).rejects.toThrow("hash");
  await expect(fetchCurrentRelease("https://test.r2.dev", missing)).rejects.toThrow("custom domain");
});

test("production seed retries manifest timeouts and verifies the recovered release", async () => {
  const release = seal();
  let manifestCalls = 0, catalogCalls = 0;
  const fetcher = (async (url: URL) => {
    if (url.pathname.endsWith("manifest.json")) {
      if (++manifestCalls === 1) throw new DOMException("connection timed out", "TimeoutError");
      return new Response(JSON.stringify(release.manifest));
    }
    catalogCalls++;
    return new Response(release.catalog);
  }) as unknown as typeof fetch;
  const active = await fetchCurrentRelease("https://example.invalid", fetcher, quickReads);
  expect(active!.bundle).toEqual(release.bundle);
  expect(manifestCalls).toBe(2);
  expect(catalogCalls).toBe(1);
});

test("production seed retries a timed-out 200 catalog body without accepting an incomplete release", async () => {
  const release = seal();
  let manifestCalls = 0, catalogCalls = 0;
  const fetcher = (async (url: URL) => {
    if (url.pathname.endsWith("manifest.json")) {
      manifestCalls++;
      return new Response(JSON.stringify(release.manifest));
    }
    if (++catalogCalls === 1) return new Response(new ReadableStream({
      start(controller) { controller.error(new DOMException("catalog body stalled", "TimeoutError")); },
    }));
    return new Response(release.catalog);
  }) as unknown as typeof fetch;
  const active = await fetchCurrentRelease("https://example.invalid", fetcher, quickReads);
  expect(active!.catalog).toBe(release.catalog);
  expect(active!.bundle.revision).toBe(release.bundle.revision);
  expect(manifestCalls).toBe(1);
  expect(catalogCalls).toBe(2);
});

test("production seed never retries corrupt catalog bytes or downgrades them to an initial release", async () => {
  const release = seal();
  let calls = 0;
  const fetcher = (async (url: URL) => {
    calls++;
    return new Response(url.pathname.endsWith("manifest.json") ? JSON.stringify(release.manifest) : release.catalog + "tampered");
  }) as unknown as typeof fetch;
  await expect(fetchCurrentRelease("https://example.invalid", fetcher, quickReads)).rejects.toThrow("hash");
  expect(calls).toBe(2);
});

test("production seed exhausts transient failures with the exact public URL and request stage", async () => {
  let calls = 0, failure: Error | undefined;
  const fetcher = (async () => { calls++; return new Response("temporarily unavailable", { status: 503 }); }) as unknown as typeof fetch;
  try { await fetchCurrentRelease("https://example.invalid", fetcher, quickReads); }
  catch (error) { failure = error as Error; }
  expect(calls).toBe(3);
  expect(failure?.message).toContain("url=https://example.invalid/v1/manifest.json");
  expect(failure?.message).toContain("phase=headers");
  expect(failure?.message).toContain("attempt=3/3");
  expect(failure?.message).toContain("HTTP 503");
});

test("a missing catalog is terminal and cannot masquerade as first publication", async () => {
  const release = seal();
  let calls = 0;
  const fetcher = (async (url: URL) => {
    calls++;
    return url.pathname.endsWith("manifest.json")
      ? new Response(JSON.stringify(release.manifest))
      : new Response("missing catalog", { status: 404 });
  }) as unknown as typeof fetch;
  await expect(fetchCurrentRelease("https://example.invalid", fetcher, quickReads)).rejects.toThrow("404");
  expect(calls).toBe(2);
});
