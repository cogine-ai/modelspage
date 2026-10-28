import { join } from "node:path";
import { verifyRelease, type VerifiedRelease } from "./client.js";
import { atomicWrite, stableStringify } from "./integrity.js";
import { readPublicBytes, type PublicReadOptions } from "./request.js";

/** Read-only production seed. A network/integrity failure must not become an empty previous input. */
export async function fetchCurrentRelease(baseUrl: string, fetcher: typeof fetch = fetch, options: Omit<PublicReadOptions, "fetcher" | "allowNotFound"> = {}): Promise<VerifiedRelease | null> {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.pathname !== "/" || base.username || base.password || base.search || base.hash || /(?:^|\.)r2\.dev$/.test(base.hostname)) throw new Error("Current release requires an HTTPS custom domain origin");
  const get = (path: string, allowNotFound = false) => readPublicBytes(new URL("/" + path, base), { ...options, fetcher, allowNotFound });
  const { response, bytes } = await get("v1/manifest.json", true);
  if (response.status === 404) return null; // Initial publication only; all other errors fail closed.
  return verifyRelease(JSON.parse(new TextDecoder().decode(bytes)), async path => (await get(path)).bytes);
}
export async function seedCurrentRelease(baseUrl: string, outDir: string, fetcher: typeof fetch = fetch, options: Omit<PublicReadOptions, "fetcher" | "allowNotFound"> = {}) {
  const active = await fetchCurrentRelease(baseUrl, fetcher, options);
  if (!active) return null;
  const previousPath = join(outDir, "catalog.json");
  await atomicWrite(previousPath, active.catalog);
  await atomicWrite(join(outDir, "manifest.json"), stableStringify(active.manifest));
  return previousPath;
}
