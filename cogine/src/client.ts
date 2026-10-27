import { bundleRevision, sha256, stableStringify } from "./integrity.js";
import { validateBundle, validateManifest } from "./schema.js";
import { type Bundle, type Manifest } from "./types.js";
import { assertCorrectionContinuity } from "./corrections.js";

export const CONSUMER_VERSION = "2.0.0";
export type VerifiedRelease = { manifest: Manifest; bundle: Bundle; catalog: string };
export type ReadObject = (path: string) => Promise<Uint8Array | string>;
function compatible(version: string) {
  const required = version.split(".").map(Number);
  const supported = CONSUMER_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (required[i]! > supported[i]!) return false; if (required[i]! < supported[i]!) return true; }
  return true;
}
/** Download to staging, validate every byte and contract, then make one host-controlled switch. */
export async function verifyRelease(input: unknown, readObject: ReadObject): Promise<VerifiedRelease> {
  const manifest = validateManifest(input);
  if (!compatible(manifest.module_compatibility.min_consumer_version)) throw new Error("Incompatible consumer version");
  const object = manifest.objects.catalog;
  const raw = await readObject(object.path);
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  if (bytes.byteLength !== object.size || sha256(bytes) !== object.sha256) throw new Error("Catalog size/hash mismatch");
  const catalog = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const bundle = validateBundle(JSON.parse(catalog));
  if (!compatible(bundle.module_compatibility.min_consumer_version)) throw new Error("Incompatible bundle consumer version");
  if (bundle.revision !== manifest.revision || bundleRevision(bundle) !== bundle.revision) throw new Error("Catalog revision mismatch");
  if (bundle.publication_sequence > manifest.publication_sequence) throw new Error("Manifest predates its catalog");
  if (bundle.fixture !== manifest.fixture) throw new Error("Fixture marker mismatch");
  if (stableStringify(bundle.module_compatibility) !== stableStringify(manifest.module_compatibility)) throw new Error("Module compatibility mismatch");
  return { manifest, bundle, catalog };
}

/** Higher publication sequence alone cannot silently drop an already observed reviewed correction. */
export function assertSafeReplacement(previous: VerifiedRelease, next: VerifiedRelease): void {
  if (next.manifest.publication_sequence < previous.manifest.publication_sequence) throw new Error("Older publication cannot replace current cache");
  if (next.manifest.publication_sequence === previous.manifest.publication_sequence && stableStringify(next.manifest) !== stableStringify(previous.manifest)) throw new Error("Publication sequence collision");
  assertCorrectionContinuity(previous.bundle.corrections, next.bundle.corrections);
}
export type CacheSnapshot = { manifest: Manifest; catalog: string; etag: string | null; last_checked_at: number; next_check_at: number; failures: number };
export type ManifestResponse = { status: 200; manifest: unknown; etag: string | null } | { status: 304; etag?: string | null };
export type CacheDependencies = {
  readSnapshot: () => Promise<CacheSnapshot | undefined>;
  /** Host must fsync staged bytes and atomically replace its persisted snapshot; failure must preserve the old file. */
  writeSnapshot: (snapshot: CacheSnapshot) => Promise<void>;
  fetchManifest: (etag: string | null) => Promise<ManifestResponse>;
  fetchObject: ReadObject;
  now?: () => number;
  checkIntervalMs?: number;
};
export type RefreshResult = { status: "updated" | "unchanged" | "deferred" | "failed"; error?: string };

/** No network in startup or projection. Background refresh is an explicit host call. */
export class ReferenceCache {
  private snapshot?: CacheSnapshot;
  private release?: VerifiedRelease;
  private inFlight?: Promise<RefreshResult>;
  private nextAttemptAt = 0;
  private failuresWithoutCache = 0;
  constructor(private readonly dependencies: CacheDependencies) {}
  get current(): VerifiedRelease | undefined { return this.release; }
  private now() { return (this.dependencies.now ?? Date.now)(); }
  private interval() { return this.dependencies.checkIntervalMs ?? 24 * 60 * 60 * 1_000; }
  async startup(bundled?: { manifest: unknown; catalog: string }): Promise<VerifiedRelease | undefined> {
    let stored: CacheSnapshot | undefined;
    try { stored = await this.dependencies.readSnapshot(); } catch { /* local storage failure falls back to bundled data */ }
    if (stored) {
      try {
        if (!Number.isFinite(stored.next_check_at) || !Number.isFinite(stored.last_checked_at) || !Number.isSafeInteger(stored.failures) || stored.failures < 0 || !(stored.etag === null || typeof stored.etag === "string")) throw new Error("Invalid cache scheduling metadata");
        this.release = await verifyRelease(stored.manifest, async () => stored!.catalog);
        this.snapshot = stored;
      } catch { /* malformed/incompatible cache is never partially applied */ }
    }
    if (bundled) {
      try {
        const candidate = await verifyRelease(bundled.manifest, async () => bundled.catalog);
        if (!this.release || candidate.manifest.publication_sequence > this.release.manifest.publication_sequence) {
          if (this.release) assertSafeReplacement(this.release, candidate);
          const snapshot: CacheSnapshot = { manifest: candidate.manifest, catalog: candidate.catalog, etag: null, last_checked_at: 0, next_check_at: this.now(), failures: 0 };
          try { await this.dependencies.writeSnapshot(snapshot); }
          catch (error) {
            // A valid packaged release still supplies offline facts when no usable cache exists.
            // If an older valid cache exists, failed persistence must preserve that release.
            if (this.release) throw error;
          }
          this.snapshot = snapshot;
          this.release = candidate;
        }
      } catch { /* invalid/newer bundled data cannot displace valid local data */ }
    }
    return this.release;
  }
  refresh(): Promise<RefreshResult> {
    if (this.inFlight) return this.inFlight;
    if (this.now() < Math.max(this.nextAttemptAt, this.snapshot?.next_check_at ?? 0)) return Promise.resolve({ status: "deferred" });
    this.inFlight = this.performRefresh().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async performRefresh(): Promise<RefreshResult> {
    try {
      const response = await this.dependencies.fetchManifest(this.snapshot?.etag ?? null);
      if (response.status === 304) {
        if (!this.snapshot || !this.release) throw new Error("304 without a valid local catalog");
        const snapshot = { ...this.snapshot, last_checked_at: this.now(), next_check_at: this.now() + this.interval(), failures: 0 };
        await this.dependencies.writeSnapshot(snapshot);
        this.snapshot = snapshot;
        this.nextAttemptAt = snapshot.next_check_at;
        this.failuresWithoutCache = 0;
        return { status: "unchanged" };
      }
      const candidate = await verifyRelease(response.manifest, this.dependencies.fetchObject);
      if (this.release) assertSafeReplacement(this.release, candidate);
      const snapshot = { manifest: candidate.manifest, catalog: candidate.catalog, etag: response.etag, last_checked_at: this.now(), next_check_at: this.now() + this.interval(), failures: 0 };
      // Persistence finishes before in-memory visibility; one release always supplies all C/P/N facts.
      await this.dependencies.writeSnapshot(snapshot);
      const changed = this.release?.manifest.publication_sequence !== candidate.manifest.publication_sequence;
      this.snapshot = snapshot;
      this.release = candidate;
      this.nextAttemptAt = snapshot.next_check_at;
      this.failuresWithoutCache = 0;
      return { status: changed ? "updated" : "unchanged" };
    } catch (error) {
      this.failuresWithoutCache = Math.min(this.failuresWithoutCache + 1, 12);
      this.nextAttemptAt = this.now() + Math.min(60_000 * 2 ** (this.failuresWithoutCache - 1), this.interval());
      if (this.snapshot) {
        const failures = Math.min(this.snapshot.failures + 1, 12);
        const next = { ...this.snapshot, failures, last_checked_at: this.now(), next_check_at: this.now() + Math.min(60_000 * 2 ** (failures - 1), this.interval()) };
        // Even storage failure keeps a usable old in-memory catalog and schedules backoff.
        try { await this.dependencies.writeSnapshot(next); } catch { /* retry on a later check */ }
        this.snapshot = next;
      }
      return { status: "failed", error: error instanceof Error ? error.message : "Refresh failed" };
    }
  }
}
