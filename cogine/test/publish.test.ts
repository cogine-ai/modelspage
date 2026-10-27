import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCorrections } from "../src/corrections.js";
import { bundleRevision, sha256, stableStringify } from "../src/integrity.js";
import { JSON_TYPE, MANIFEST_CACHE, publishRelease, publicVerifier, readRelease, REVISION_CACHE, rollbackRelease, verifyReleaseBytes, type Release } from "../src/publish.js";
import { configuredR2Store, DirectoryStore, MemoryStore, PreconditionFailed, R2Store, type Condition, type Metadata } from "../src/store.js";
import { bundle, capability, identity, model, popularity, seal, timestamp } from "./contract-fixture.js";

function fixture(sequence = 1): Release {
  const sealed = seal(bundle({ publication_sequence: sequence, builder_version: `test-build-${sequence}` }));
  return { ...sealed, catalogBody: sealed.catalog };
}
const dry = { allowFixture: true };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe("immutable publication and CAS manifest", () => {
  test("uploads and verifies immutable objects before first conditional manifest creation", async () => {
    const store = new MemoryStore();
    const release = fixture();
    const visited: string[] = [];
    const result = await publishRelease(store, release, { ...dry, verifyPublic: async (key) => { visited.push(key); if (key !== "v1/manifest.json") expect(await store.get("v1/manifest.json")).toBeNull(); } });
    expect(result.status).toBe("published");
    expect(visited).toEqual([release.manifest.objects.catalog.path, "v1/manifest.json"]);
    expect(store.writes.map(x => x.condition)).toEqual([{ ifNoneMatch: "*" }, { ifNoneMatch: "*" }]);
    const previous = (await store.get("v1/manifest.json"))!;
    await publishRelease(store, fixture(2), dry);
    expect(store.writes.at(-1)!.condition).toEqual({ ifMatch: previous.etag });
    expect(await store.get(release.manifest.objects.catalog.path)).not.toBeNull();
  });
  test("identical publication is idempotent and older/equal conflicting sequences are rejected", async () => {
    const store = new MemoryStore();
    await publishRelease(store, fixture(2), dry);
    const count = store.writes.length;
    expect((await publishRelease(store, fixture(2), dry)).status).toBe("unchanged");
    expect(store.writes.length).toBe(count);
    await expect(publishRelease(store, fixture(1), dry)).rejects.toThrow("Stale");
    const changed = seal(bundle({ publication_sequence: 2, builder_version: "other" }));
    await expect(publishRelease(store, { ...changed, catalogBody: changed.catalog }, dry)).rejects.toThrow("different content");
  });
  test("existing revision bytes can never be overwritten", async () => {
    const store = new MemoryStore(); const release = fixture();
    const key = release.manifest.objects.catalog.path;
    await store.put(key, "corrupt", { contentType: JSON_TYPE, cacheControl: REVISION_CACHE }, { ifNoneMatch: "*" });
    await expect(publishRelease(store, release, dry)).rejects.toThrow("collision");
    expect((await store.get(key))!.body).toBe("corrupt");
    expect(await store.get("v1/manifest.json")).toBeNull();
  });
  test("idempotent publication still verifies manifest metadata and public reachability", async () => {
    const store = new MemoryStore(); const release = fixture();
    await publishRelease(store, release, dry);
    await expect(publishRelease(store, release, { ...dry, verifyPublic: async key => { if (key === "v1/manifest.json") throw new Error("unreachable manifest"); } })).rejects.toThrow("unreachable");
    store.objects.get("v1/manifest.json")!.cacheControl = "public, max-age=31536000";
    await expect(publishRelease(store, release, dry)).rejects.toThrow("metadata mismatch");
  });
  test("unchanged inputs do not manufacture a new publication or freshness time", async () => {
    const store = new MemoryStore(); const release = fixture();
    await publishRelease(store, release, dry);
    const updatedMetadata = seal({ ...release.bundle, publication_sequence: 2, published_at: "2026-10-26T00:00:00.000Z" });
    const result = await publishRelease(store, { ...updatedMetadata, catalogBody: updatedMetadata.catalog }, dry);
    expect(result).toEqual({ status: "unchanged", sequence: 1, revision: release.bundle.revision });
    expect(store.writes.length).toBe(2);
    expect(JSON.parse((await store.get("v1/manifest.json"))!.body).published_at).toBe(timestamp);
  });
  test("public verification failure prevents manifest publication", async () => {
    const store = new MemoryStore();
    await expect(publishRelease(store, fixture(), { ...dry, verifyPublic: async () => { throw new Error("public hash mismatch"); } })).rejects.toThrow("public hash");
    expect(await store.get("v1/manifest.json")).toBeNull();
  });
  test("CAS race re-reads newer manifest and refuses stale overwrite", async () => {
    class RacingStore extends MemoryStore {
      raced = false;
      override async put(key: string, body: string, metadata: Metadata, condition: Condition) {
        if (key === "v1/manifest.json" && !this.raced) {
          this.raced = true;
          await publishRelease(this, fixture(3), dry);
        }
        return super.put(key, body, metadata, condition);
      }
    }
    const store = new RacingStore();
    await expect(publishRelease(store, fixture(2), dry)).rejects.toThrow("Stale");
    expect(JSON.parse((await store.get("v1/manifest.json"))!.body).publication_sequence).toBe(3);
  });
  test("transient conditional failure re-reads and re-compares before a conditional retry", async () => {
    class BusyStore extends MemoryStore {
      failed = false;
      override async put(key: string, body: string, metadata: Metadata, condition: Condition) {
        if (key === "v1/manifest.json" && !this.failed) { this.failed = true; throw new PreconditionFailed("busy"); }
        return super.put(key, body, metadata, condition);
      }
    }
    const store = new BusyStore();
    expect((await publishRelease(store, fixture(), dry)).status).toBe("published");
    expect(store.writes.at(-1)!.condition).toEqual({ ifNoneMatch: "*" });
  });
  test("rollback increases manifest sequence while keeping verified old immutable bytes", async () => {
    const store = new MemoryStore(); const first = fixture(1);
    await publishRelease(store, first, dry); await publishRelease(store, fixture(2), dry);
    const rollback = rollbackRelease(first, 3, "2026-10-26T00:00:00.000Z");
    expect(rollback.bundle.publication_sequence).toBe(1);
    await publishRelease(store, rollback, dry);
    const manifest = JSON.parse((await store.get("v1/manifest.json"))!.body);
    expect(manifest.publication_sequence).toBe(3); expect(manifest.revision).toBe(first.bundle.revision);
    expect(() => rollbackRelease(first, 1, timestamp)).toThrow("higher sequence");
  });
  test("rollback cannot silently revive a newly withdrawn field", async () => {
    const store = new MemoryStore(); const first = fixture(); await publishRelease(store, first, dry);
    const input = bundle({ publication_sequence: 2, corrections: [{ id: "revoke", identity: identity(), field: "release", action: "withdraw", sequence: 1, reason: "Wrong source", evidence: "Review", reviewed_by: "maintainer", reviewed_at: timestamp }] });
    input.facts = applyCorrections(input.facts, input.corrections);
    const withdrawn = seal(input); await publishRelease(store, { ...withdrawn, catalogBody: withdrawn.catalog }, dry);
    await expect(publishRelease(store, rollbackRelease(first, 3, timestamp), dry)).rejects.toThrow("withdrawal");
  });
  test("production rejects fixtures, unlicensed facts and partial rankings", async () => {
    await expect(publishRelease(new MemoryStore(), fixture())).rejects.toThrow("Synthetic");
    const input = bundle({ fixture: false }); input.source_revisions[0]!.usage.redistribution = "unverified";
    const unlicensed = seal(input);
    await expect(publishRelease(new MemoryStore(), { ...unlicensed, catalogBody: unlicensed.catalog })).rejects.toThrow("rights");
    const partialInput = bundle({ fixture: false });
    partialInput.facts[0]!.popularity = popularity(1);
    partialInput.source_revisions[0]!.complete = false;
    partialInput.source_revisions[0]!.status = "partial";
    const partial = seal(partialInput);
    await expect(publishRelease(new MemoryStore(), { ...partial, catalogBody: partial.catalog })).rejects.toThrow("Incomplete");
  });
  test("direct production publication cannot bypass initial C/P/N readiness, but permits later withdrawal", async () => {
    const store = new MemoryStore();
    const missing = seal(bundle({ fixture: false }));
    await expect(publishRelease(store, { ...missing, catalogBody: missing.catalog })).rejects.toThrow("Initial production");
    expect(store.writes).toHaveLength(0);
    const input = bundle({ fixture: false, facts: [model("model-v1", { capability: capability(90), popularity: popularity(1) })] });
    const first = seal(input);
    await publishRelease(store, { ...first, catalogBody: first.catalog });
    input.publication_sequence = 2;
    input.corrections = [{ id: "remove-capability", identity: identity(), field: "capability", action: "withdraw", sequence: 1, reason: "Evidence withdrawn", evidence: "Synthetic review", reviewed_by: "test", reviewed_at: timestamp }];
    input.facts = applyCorrections(input.facts, input.corrections);
    const withdrawn = seal(input);
    expect((await publishRelease(store, { ...withdrawn, catalogBody: withdrawn.catalog })).status).toBe("published");
  });
  test("a CAS retry that observes a removed manifest must recheck the initial C/P/N gate", async () => {
    const store = new MemoryStore();
    const first = seal(bundle({ fixture: false, facts: [model("model-v1", { capability: capability(90), popularity: popularity(1) })] }));
    await publishRelease(store, { ...first, catalogBody: first.catalog });
    const next = seal(bundle({ fixture: false, publication_sequence: 2 }));
    await expect(publishRelease(store, { ...next, catalogBody: next.catalog }, { verifyPublic: async key => {
      if (key !== "v1/manifest.json") store.objects.delete("v1/manifest.json");
    } })).rejects.toThrow("Initial production");
    expect(await store.get("v1/manifest.json")).toBeNull();
    expect(store.writes.filter(write => write.key === "v1/manifest.json")).toHaveLength(1);
  });
  test("persisted dry-run store enforces CAS across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "modelspage-store-")); directories.push(directory);
    const store = new DirectoryStore(directory); await publishRelease(store, fixture(), dry);
    const other = new DirectoryStore(directory);
    await expect(other.put("v1/manifest.json", "bad", { contentType: JSON_TYPE, cacheControl: MANIFEST_CACHE }, { ifNoneMatch: "*" })).rejects.toBeInstanceOf(PreconditionFailed);
    expect((await publishRelease(other, fixture(), dry)).status).toBe("unchanged");
  });
  test("hashes include metadata and tampered/missing input is rejected", async () => {
    const release = fixture();
    expect(bundleRevision({ ...release.bundle, published_at: "2020-01-01T00:00:00.000Z" })).not.toBe(release.bundle.revision);
    expect(() => verifyReleaseBytes(release.manifest, release.catalogBody + " ")).toThrow("hash");
    await expect(readRelease("/nonexistent/modelspage-test")).rejects.toThrow();
  });
});
describe("production transport configuration", () => {
  test("SDK sends actual S3 conditional headers, no unconditional put", async () => {
    const commands: any[] = [];
    const client = { send: async (command: any) => { commands.push(command); return {}; } };
    const store = new R2Store(client as any, "isolated-test-bucket");
    await store.put("v1/manifest.json", "{}", { contentType: JSON_TYPE, cacheControl: MANIFEST_CACHE }, { ifMatch: '"current"' });
    expect(commands[0].input).toMatchObject({ IfMatch: '"current"', Bucket: "isolated-test-bucket", ContentType: JSON_TYPE });
    await store.put("v1/manifest.json", "{}", { contentType: JSON_TYPE, cacheControl: MANIFEST_CACHE }, { ifNoneMatch: "*" });
    expect(commands[1].input.IfNoneMatch).toBe("*");
    const rejecting = new R2Store({ send: async () => { throw { $metadata: { httpStatusCode: 412 } }; } } as any, "test");
    await expect(rejecting.put("v1/manifest.json", "{}", { contentType: JSON_TYPE, cacheControl: MANIFEST_CACHE }, { ifNoneMatch: "*" })).rejects.toBeInstanceOf(PreconditionFailed);
  });
  test("production is off by default and r2.dev is not accepted as custom domain", () => {
    expect(() => configuredR2Store({})).toThrow("disabled");
    const env = { MODELSPAGE_PUBLISH_ENABLED: "true", MODELSPAGE_PUBLIC_BASE_URL: "https://example.r2.dev", MODELSPAGE_R2_ACCOUNT_ID: "a".repeat(32), MODELSPAGE_R2_BUCKET: "test", MODELSPAGE_R2_ACCESS_KEY_ID: "test", MODELSPAGE_R2_SECRET_ACCESS_KEY: "test" };
    expect(() => configuredR2Store(env)).toThrow("custom domain");
  });
  test("public path verification requires JSON/cache/ETag and matching content", async () => {
    const metadata = { contentType: JSON_TYPE, cacheControl: REVISION_CACHE };
    const fetcher = (async () => new Response("{}", { headers: { "Content-Type": JSON_TYPE, "Cache-Control": REVISION_CACHE, ETag: '"etag"' } })) as unknown as typeof fetch;
    await publicVerifier("https://example.invalid", fetcher)("v1/revisions/test/catalog.json", "{}", metadata);
    await expect(publicVerifier("https://example.invalid", fetcher)("v1/revisions/test/catalog.json", "wrong", metadata)).rejects.toThrow("verification");
  });
});
