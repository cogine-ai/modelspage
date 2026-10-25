import { expect, test } from "bun:test";
import { fetchCurrentRelease } from "../src/active.js";
import { seal } from "./contract-fixture.js";

test("production seed verifies the complete active catalog; first 404 alone means no prior input", async () => {
  const release = seal();
  const fetcher = (async (url: URL) => new Response(url.pathname.endsWith("manifest.json") ? JSON.stringify(release.manifest) : release.catalog, { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  expect((await fetchCurrentRelease("https://example.invalid", fetcher))!.bundle).toEqual(release.bundle);
  const missing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
  expect(await fetchCurrentRelease("https://example.invalid", missing)).toBeNull();
  const failed = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  await expect(fetchCurrentRelease("https://example.invalid", failed)).rejects.toThrow("503");
  const corrupt = (async (url: URL) => new Response(url.pathname.endsWith("manifest.json") ? JSON.stringify(release.manifest) : "{}")) as unknown as typeof fetch;
  await expect(fetchCurrentRelease("https://example.invalid", corrupt)).rejects.toThrow("hash");
  await expect(fetchCurrentRelease("https://test.r2.dev", missing)).rejects.toThrow("custom domain");
});
