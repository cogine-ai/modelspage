import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bundle, Manifest } from "./types.js";
import { assertCorrectionContinuity } from "./corrections.js";
import { bundleRevision, sha256, stableStringify } from "./integrity.js";
import { validateBundle, validateManifest } from "./schema.js";
import { assertInitialCpnReadiness } from "./readiness.js";
import { PreconditionFailed, type Metadata, type ObjectStore, type StoredObject } from "./store.js";

export const JSON_TYPE = "application/json; charset=utf-8";
export const REVISION_CACHE = "public, max-age=31536000, immutable";
export const MANIFEST_CACHE = "public, max-age=0, must-revalidate";
export type Release = { manifest: Manifest; bundle: Bundle; catalogBody: string };
export type PublicVerifier = (key: string, body: string, metadata: Metadata) => Promise<void>;
export function verifyReleaseBytes(manifestInput: unknown, body: string): Release {
  const manifest = validateManifest(manifestInput);
  const descriptor = manifest.objects.catalog;
  if (descriptor.path !== `v1/revisions/${manifest.revision}/catalog.json`) throw new Error("Unexpected catalog path");
  if (Buffer.byteLength(body) !== descriptor.size || sha256(body) !== descriptor.sha256) throw new Error("Catalog hash or size mismatch");
  const bundle = validateBundle(JSON.parse(body));
  if (bundle.revision !== manifest.revision || bundleRevision(bundle) !== bundle.revision || bundle.publication_sequence > manifest.publication_sequence || bundle.fixture !== manifest.fixture) throw new Error("Release metadata mismatch");
  if (stableStringify(bundle.module_compatibility) !== stableStringify(manifest.module_compatibility)) throw new Error("Module compatibility mismatch");
  return { manifest, bundle, catalogBody: body };
}
export async function readRelease(directory: string): Promise<Release> {
  const manifest = validateManifest(JSON.parse(await readFile(join(directory, "v1/manifest.json"), "utf8")));
  // Validate expected path before using a manifest path for filesystem access.
  if (manifest.objects.catalog.path !== `v1/revisions/${manifest.revision}/catalog.json`) throw new Error("Unexpected catalog path");
  return verifyReleaseBytes(manifest, await readFile(join(directory, manifest.objects.catalog.path), "utf8"));
}
export function assertPublishable(bundle: Bundle) {
  if (bundle.fixture) throw new Error("Synthetic fixture releases cannot be published to production");
  const sources = new Map(bundle.source_revisions.map(s => [s.id, s]));
  for (const model of bundle.facts) for (const field of ["release", "capability", "popularity"] as const) {
    const fact = model[field];
    if (fact.state !== "known") continue;
    const source = sources.get(fact.source_id);
    if (!source || source.usage.redistribution !== "allowed") throw new Error(`Publication rights unconfirmed for source ${fact.source_id}`);
    if (field === "popularity" && !source.complete) throw new Error("Incomplete popularity snapshots cannot be published");
    if (field === "popularity" && model.popularity.state === "known" && model.popularity.value.weighted) {
      for (const [id, evidence] of Object.entries(model.popularity.value.weighted.sources)) if (evidence.observed_days) {
        if (sources.get(id)?.usage.redistribution !== "allowed") throw new Error(`Publication rights unconfirmed for popularity component ${id}`);
        if (!sources.get(id)?.complete) throw new Error(`Incomplete popularity component ${id}`);
      }
    }
    if (field === "capability") {
      const profileId = model.capability.state === "known" ? model.capability.value.profile_id : "";
      const profile = bundle.metric_profiles.find(p => p.id === profileId);
      if (!profile || profile.usage.redistribution !== "allowed") throw new Error("Capability profile is not approved for distribution");
    }
  }
}
function validateStored(object: StoredObject, body: string, metadata: Metadata) {
  if (object.body !== body || sha256(object.body) !== sha256(body)) throw new Error("Immutable object collision or corrupt remote bytes");
  if (!object.etag || object.contentType !== metadata.contentType || object.cacheControl !== metadata.cacheControl) throw new Error("Remote object metadata mismatch");
}
export async function publishRelease(store: ObjectStore, release: Release, options: { allowFixture?: boolean; verifyPublic?: PublicVerifier } = {}): Promise<{ status: "published" | "unchanged"; sequence: number; revision: string }> {
  const checked = verifyReleaseBytes(release.manifest, release.catalogBody);
  if (!options.allowFixture) assertPublishable(checked.bundle);
  const manifestBody = stableStringify(checked.manifest);
  const key = checked.manifest.objects.catalog.path;
  const immutableMetadata = { contentType: JSON_TYPE, cacheControl: REVISION_CACHE };
  const manifestMetadata = { contentType: JSON_TYPE, cacheControl: MANIFEST_CACHE };
  const targetSequence = checked.manifest.publication_sequence;
  // Reject stale input before uploading, then compare again within the CAS loop.
  let current = await store.get("v1/manifest.json");
  if (!current && !options.allowFixture) assertInitialCpnReadiness(checked.bundle);
  function compare(object: StoredObject | null): "new" | "same" {
    if (!object) return "new";
    const active = validateManifest(JSON.parse(object.body));
    if (active.publication_sequence > targetSequence) throw new Error("Stale publication_sequence");
    if (active.publication_sequence === targetSequence) {
      if (object.body === manifestBody) return "same";
      throw new Error("publication_sequence already identifies different content");
    }
    return "new";
  }
  compare(current);
  if (current) {
    const activeManifest = validateManifest(JSON.parse(current.body));
    const activeObject = await store.get(activeManifest.objects.catalog.path);
    if (!activeObject) throw new Error("Active catalog is missing; repair before publishing");
    const active = verifyReleaseBytes(activeManifest, activeObject.body);
    if (!options.allowFixture && active.bundle.fixture) throw new Error("An active fixture cannot seed production publication");
    const content = (bundle: Bundle) => {
      const { revision: _revision, publication_sequence: _sequence, published_at: _published, ...facts } = bundle;
      return stableStringify(facts);
    };
    if (activeManifest.publication_sequence < targetSequence && content(active.bundle) === content(checked.bundle)) {
      validateStored(activeObject, active.catalogBody, immutableMetadata);
      validateStored(current, stableStringify(activeManifest), manifestMetadata);
      await options.verifyPublic?.(activeManifest.objects.catalog.path, active.catalogBody, immutableMetadata);
      await options.verifyPublic?.("v1/manifest.json", current.body, manifestMetadata);
      return { status: "unchanged", sequence: activeManifest.publication_sequence, revision: activeManifest.revision };
    }
  }
  let immutable = await store.get(key);
  if (!immutable) {
    try { await store.put(key, checked.catalogBody, immutableMetadata, { ifNoneMatch: "*" }); }
    catch (e) { if (!(e instanceof PreconditionFailed)) throw e; }
    immutable = await store.get(key);
  }
  if (!immutable) throw new Error("Uploaded revision is missing");
  validateStored(immutable, checked.catalogBody, immutableMetadata);
  await options.verifyPublic?.(key, checked.catalogBody, immutableMetadata);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!current && !options.allowFixture) assertInitialCpnReadiness(checked.bundle);
    const comparison = compare(current);
    if (comparison === "same") {
      validateStored(current!, manifestBody, manifestMetadata);
      await options.verifyPublic?.("v1/manifest.json", manifestBody, manifestMetadata);
      return { status: "unchanged", sequence: targetSequence, revision: checked.manifest.revision };
    }
    if (current) {
      const activeManifest = validateManifest(JSON.parse(current.body));
      const activeObject = await store.get(activeManifest.objects.catalog.path);
      if (!activeObject) throw new Error("Active catalog is missing; repair before publishing");
      const previous = verifyReleaseBytes(activeManifest, activeObject.body);
      if (!options.allowFixture && previous.bundle.fixture) throw new Error("An active fixture cannot seed production publication");
      assertCorrectionContinuity(previous.bundle.corrections, checked.bundle.corrections);
    }
    try {
      await store.put("v1/manifest.json", manifestBody, manifestMetadata, current ? { ifMatch: current.etag } : { ifNoneMatch: "*" });
      const committed = await store.get("v1/manifest.json");
      if (!committed) throw new Error("Manifest missing after conditional write");
      // Another newer writer may already have advanced it; never undo that write.
      const observed = validateManifest(JSON.parse(committed.body));
      if (observed.publication_sequence < targetSequence) throw new Error("Manifest did not commit");
      if (observed.publication_sequence === targetSequence) {
        validateStored(committed, manifestBody, manifestMetadata);
        await options.verifyPublic?.("v1/manifest.json", manifestBody, manifestMetadata);
      }
      return { status: "published", sequence: targetSequence, revision: checked.manifest.revision };
    } catch (e) {
      if (!(e instanceof PreconditionFailed)) throw e;
      current = await store.get("v1/manifest.json");
      // Conditional failures always re-read/re-compare, never retry unconditionally.
    }
  }
  throw new Error("Concurrent publication did not settle; rerun after reading current manifest");
}
export function rollbackRelease(release: Release, sequence: number, publishedAt: string): Release {
  if (!Number.isSafeInteger(sequence) || sequence <= release.manifest.publication_sequence || !Number.isFinite(Date.parse(publishedAt))) throw new Error("Rollback requires a higher sequence and valid publication time");
  return verifyReleaseBytes({ ...release.manifest, publication_sequence: sequence, published_at: publishedAt }, release.catalogBody);
}
export function publicVerifier(baseUrl: string, fetcher: typeof fetch = fetch): PublicVerifier {
  return async (key, body, metadata) => {
    const response = await fetcher(new URL("/" + key, baseUrl), { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.headers.get("etag") || !response.headers.get("content-type")?.startsWith("application/json") || response.headers.get("cache-control") !== metadata.cacheControl || sha256(await response.text()) !== sha256(body)) throw new Error(`Public object verification failed: ${key}`);
  };
}
