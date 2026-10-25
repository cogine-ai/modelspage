import { join } from "node:path";
import { verifyRelease, type VerifiedRelease } from "./client.js";
import { atomicWrite, stableStringify } from "./integrity.js";

/** Read-only production seed. A network/integrity failure must not become an empty previous input. */
export async function fetchCurrentRelease(baseUrl: string, fetcher: typeof fetch = fetch): Promise<VerifiedRelease | null> {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.pathname !== "/" || base.username || base.password || base.search || base.hash || /(?:^|\.)r2\.dev$/.test(base.hostname)) throw new Error("Current release requires an HTTPS custom domain origin");
  const get = (path: string) => fetcher(new URL("/" + path, base), { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
  const response = await get("v1/manifest.json");
  if (response.status === 404) return null; // Initial publication only; all other errors fail closed.
  if (!response.ok) throw new Error(`Cannot read active manifest: HTTP ${response.status}`);
  return verifyRelease(await response.json(), async path => {
    const object = await get(path);
    if (!object.ok) throw new Error(`Cannot read active catalog: HTTP ${object.status}`);
    return new Uint8Array(await object.arrayBuffer());
  });
}
export async function seedCurrentRelease(baseUrl: string, outDir: string, fetcher: typeof fetch = fetch) {
  const active = await fetchCurrentRelease(baseUrl, fetcher);
  if (!active) return null;
  const previousPath = join(outDir, "catalog.json");
  await atomicWrite(previousPath, active.catalog);
  await atomicWrite(join(outDir, "manifest.json"), stableStringify(active.manifest));
  return previousPath;
}
