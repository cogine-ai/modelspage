import { expect, test } from "bun:test";
import { publishRelease } from "../src/publish.js";
import { MemoryStore } from "../src/store.js";
import { seal } from "./contract-fixture.js";

test("idempotent publication still verifies manifest metadata and public path", async () => {
  const store = new MemoryStore();
  const fixture = seal();
  const release = { manifest: fixture.manifest, bundle: fixture.bundle, catalogBody: fixture.catalog };
  await publishRelease(store, release, { allowFixture: true });
  const paths: string[] = [];
  await publishRelease(store, release, { allowFixture: true, verifyPublic: async key => { paths.push(key); } });
  expect(paths).toContain("v1/manifest.json");
  store.objects.get("v1/manifest.json")!.cacheControl = "public, max-age=31536000, immutable";
  await expect(publishRelease(store, release, { allowFixture: true })).rejects.toThrow("metadata");
});
