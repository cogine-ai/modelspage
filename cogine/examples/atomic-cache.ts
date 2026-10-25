import { readFile } from "node:fs/promises";
import { atomicWrite, stableStringify } from "../src/integrity.js";
import { ReferenceCache, type CacheSnapshot } from "../src/client.js";

/** Host-side example. Never send the available directory or account data to this public endpoint. */
export function createHostCache(baseUrl: string, localSnapshotPath: string) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:") throw new Error("Public cache base URL requires HTTPS");
  return new ReferenceCache({
    readSnapshot: async () => {
      try { return JSON.parse(await readFile(localSnapshotPath, "utf8")) as CacheSnapshot; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    },
    writeSnapshot: snapshot => atomicWrite(localSnapshotPath, stableStringify(snapshot)),
    fetchManifest: async etag => {
      const response = await fetch(new URL("v1/manifest.json", base), { headers: etag ? { "If-None-Match": etag } : {}, signal: AbortSignal.timeout(30_000) });
      if (response.status === 304) return { status: 304 };
      if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
      return { status: 200, manifest: await response.json(), etag: response.headers.get("ETag") };
    },
    fetchObject: async path => {
      const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  });
}
