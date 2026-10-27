import { describe, expect, test } from "bun:test";
import { ReferenceCache, assertSafeReplacement, verifyRelease, type CacheSnapshot, type ManifestResponse } from "../src/client.js";
import { bundle, identity, release, seal, timestamp } from "./contract-fixture.js";

const verify = (sealed = seal()) => verifyRelease(sealed.manifest, async () => sealed.catalog);
function host(options: { stored?: CacheSnapshot; fetchManifest?: () => Promise<ManifestResponse>; failWrites?: () => boolean } = {}) {
  let clock = 0;
  let stored = options.stored;
  let calls = 0;
  const next = seal(bundle({ publication_sequence: 2 }));
  const cache = new ReferenceCache({
    now: () => clock,
    readSnapshot: async () => stored,
    writeSnapshot: async candidate => { if (options.failWrites?.()) throw new Error("Disk unavailable"); stored = structuredClone(candidate); },
    fetchManifest: async () => { calls++; return options.fetchManifest ? options.fetchManifest() : { status: 200, manifest: next.manifest, etag: '"fixture-etag"' }; },
    fetchObject: async () => next.catalog,
  });
  return { cache, next, advance: (milliseconds: number) => { clock += milliseconds; }, calls: () => calls, stored: () => stored };
}

describe("staged verified consumer update", () => {
  test("missing objects, hash error and incompatible schema reject entire release", async () => {
    const sealed = seal();
    expect((await verify(sealed)).bundle.revision).toBe(sealed.bundle.revision);
    await expect(verifyRelease(sealed.manifest, async () => { throw new Error("404"); })).rejects.toThrow("404");
    await expect(verifyRelease(sealed.manifest, async () => sealed.catalog + " ")).rejects.toThrow("hash");
    await expect(verifyRelease({ ...sealed.manifest, schema_version: 2 }, async () => sealed.catalog)).rejects.toThrow();
    const incompatible = seal(bundle({ module_compatibility: { projection: 1, min_consumer_version: "3.0.0" } }));
    await expect(verify(incompatible)).rejects.toThrow("Incompatible");
    const tampered = seal();
    tampered.bundle.revision = "f".repeat(64);
    // Even a matching object hash does not excuse a revision that fails semantic integrity.
    const forged = seal(tampered.bundle);
    forged.manifest.revision = "f".repeat(64);
    forged.manifest.objects.catalog.path = `v1/revisions/${"f".repeat(64)}/catalog.json`;
    await expect(verifyRelease(forged.manifest, async () => forged.catalog)).rejects.toThrow("revision");
  });
  test("rollback can point higher sequence at verified older catalog", async () => {
    const old = seal(bundle({ publication_sequence: 1 }), 10);
    expect((await verify(old)).manifest.publication_sequence).toBe(10);
    const futureBundle = seal(bundle({ publication_sequence: 11 }), 10);
    await expect(verify(futureBundle)).rejects.toThrow("predates");
  });
  test("lower publication and equal-sequence collisions cannot replace cache", async () => {
    const previous = await verify(seal(bundle({ publication_sequence: 2 })));
    const old = await verify(seal());
    expect(() => assertSafeReplacement(previous, old)).toThrow("Older");
    const collision = await verify(seal(bundle({ publication_sequence: 2, builder_version: "different-builder" })));
    expect(() => assertSafeReplacement(previous, collision)).toThrow("collision");
  });
  test("new withdrawals cannot be resurrected by old content or newer packaged defaults", async () => {
    const correction = { id: "withdraw", identity: identity(), field: "release" as const, action: "withdraw" as const, reason: "Wrong date", evidence: "Review", reviewed_by: "maintainer", reviewed_at: timestamp, sequence: 1 };
    const withdrawn = bundle({ publication_sequence: 2, corrections: [correction] });
    withdrawn.facts[0]!.release = { state: "withdrawn", correction_id: correction.id, reason: correction.reason };
    const previous = await verify(seal(withdrawn));
    const resurrection = await verify(seal(bundle({ publication_sequence: 3 })));
    expect(() => assertSafeReplacement(previous, resurrection)).toThrow("withdrawal");
    const restored = structuredClone(withdrawn);
    restored.publication_sequence = 4;
    restored.corrections.push({ ...correction, id: "reviewed-reinstatement", sequence: 2, action: "replace", value: release("2020-01-01") });
    restored.facts[0]!.release = release("2020-01-01");
    expect(() => assertSafeReplacement(previous, { ...resurrection, bundle: restored })).not.toThrow();
    const stored: CacheSnapshot = { manifest: previous.manifest, catalog: previous.catalog, etag: '"old"', last_checked_at: 0, next_check_at: 0, failures: 0 };
    const { cache } = host({ stored });
    await cache.startup({ manifest: resurrection.manifest, catalog: resurrection.catalog });
    expect(cache.current!.manifest.publication_sequence).toBe(2);
  });
});

describe("last valid local cache lifecycle", () => {
  test("startup is offline and preserves newer compatible cache across app upgrades", async () => {
    const newer = seal(bundle({ publication_sequence: 5 }));
    const stored: CacheSnapshot = { manifest: newer.manifest, catalog: newer.catalog, etag: '"stored"', last_checked_at: 0, next_check_at: 0, failures: 0 };
    const environment = host({ stored });
    const bundled = seal();
    await environment.cache.startup({ manifest: bundled.manifest, catalog: bundled.catalog });
    expect(environment.calls()).toBe(0);
    expect(environment.cache.current!.manifest.publication_sequence).toBe(5);
  });
  test("corrupt cache falls back to a compatible bundled release without network", async () => {
    const packaged = seal();
    const stored: CacheSnapshot = { manifest: packaged.manifest, catalog: packaged.catalog + "corrupt", etag: null, last_checked_at: 0, next_check_at: 0, failures: 0 };
    const environment = host({ stored });
    await environment.cache.startup({ manifest: packaged.manifest, catalog: packaged.catalog });
    expect(environment.cache.current!.bundle.revision).toBe(packaged.bundle.revision);
    expect(environment.calls()).toBe(0);
  });
  test("offline packaged fallback remains usable when initial cache persistence fails", async () => {
    const packaged = seal();
    const environment = host({ failWrites: () => true });
    await environment.cache.startup({ manifest: packaged.manifest, catalog: packaged.catalog });
    expect(environment.cache.current!.bundle.revision).toBe(packaged.bundle.revision);
    expect(environment.stored()).toBeUndefined();
    expect(environment.calls()).toBe(0);
    const stored: CacheSnapshot = { manifest: packaged.manifest, catalog: packaged.catalog, etag: null, last_checked_at: 0, next_check_at: 0, failures: 0 };
    const existing = host({ stored, failWrites: () => true });
    const newerPackaged = seal(bundle({ publication_sequence: 3 }));
    await existing.cache.startup({ manifest: newerPackaged.manifest, catalog: newerPackaged.catalog });
    expect(existing.cache.current!.manifest.publication_sequence).toBe(1);
    expect(existing.stored()!.manifest.publication_sequence).toBe(1);
  });
  test("refresh deduplicates and all three indexes switch only after persistence", async () => {
    let resolveManifest!: (response: ManifestResponse) => void;
    const environment = host({ fetchManifest: () => new Promise(resolve => { resolveManifest = resolve; }) });
    const packaged = seal();
    await environment.cache.startup({ manifest: packaged.manifest, catalog: packaged.catalog });
    const first = environment.cache.refresh();
    const second = environment.cache.refresh();
    expect(first).toBe(second);
    expect(environment.calls()).toBe(1);
    expect(environment.cache.current!.manifest.publication_sequence).toBe(1);
    resolveManifest({ status: 200, manifest: environment.next.manifest, etag: '"next"' });
    expect(await first).toEqual({ status: "updated" });
    expect(environment.cache.current!.manifest.publication_sequence).toBe(2);
    expect(environment.stored()!.manifest).toEqual(environment.cache.current!.manifest);
    expect(await environment.cache.refresh()).toEqual({ status: "deferred" });
  });
  test("ETag/304 checks every 24 hours and TTL never expires useful facts", async () => {
    const environment = host({ fetchManifest: async () => ({ status: 304 }) });
    const packaged = seal();
    await environment.cache.startup({ manifest: packaged.manifest, catalog: packaged.catalog });
    expect(await environment.cache.refresh()).toEqual({ status: "unchanged" });
    environment.advance(23 * 60 * 60 * 1_000);
    expect(await environment.cache.refresh()).toEqual({ status: "deferred" });
    expect(environment.cache.current!.bundle.revision).toBe(packaged.bundle.revision);
    environment.advance(60 * 60 * 1_000);
    expect(await environment.cache.refresh()).toEqual({ status: "unchanged" });
    expect(environment.calls()).toBe(2);
  });
  test("failed download or durable write preserves old cache and backs off", async () => {
    let failWrites = false;
    const environment = host({ failWrites: () => failWrites });
    const packaged = seal();
    await environment.cache.startup({ manifest: packaged.manifest, catalog: packaged.catalog });
    failWrites = true;
    expect((await environment.cache.refresh()).status).toBe("failed");
    expect(environment.cache.current!.manifest.publication_sequence).toBe(1);
    expect(environment.stored()!.manifest.publication_sequence).toBe(1);
    expect(await environment.cache.refresh()).toEqual({ status: "deferred" });
    environment.advance(60_000);
    failWrites = false;
    expect((await environment.cache.refresh()).status).toBe("updated");
  });
  test("no cache also backs off after failure; 304 without cache is rejected", async () => {
    const environment = host({ fetchManifest: async () => ({ status: 304 }) });
    await environment.cache.startup();
    expect((await environment.cache.refresh()).status).toBe("failed");
    expect(await environment.cache.refresh()).toEqual({ status: "deferred" });
    expect(environment.calls()).toBe(1);
    environment.advance(60_000);
    expect((await environment.cache.refresh()).status).toBe("failed");
    expect(environment.cache.current).toBeUndefined();
  });
});
