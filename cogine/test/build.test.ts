import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build, mergeCorrections, sparsePublicFacts } from "../src/build.js";
import type { Correction, ModelFacts, Mapping } from "../src/types.js";
import { bundleRevision } from "../src/integrity.js";
import { assertPublishable } from "../src/publish.js";

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "modelspage-review-build-"));
  await mkdir(path.join(root, "cogine"));
  await cp(path.resolve("cogine/fixtures"), path.join(root, "cogine/fixtures"), { recursive: true });
  return root;
}

test("complete fixture pipeline builds reproducible compact artifacts without network", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelspage-build-"));
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("Offline fixture build tried to access the network"); }) as unknown as typeof fetch;
  try {
    const options = { fixture: true, publishedAt: "2026-10-26T00:00:00Z", sequence: 1 };
    const first = await build({ ...options, outDir: path.join(directory, "one") });
    const second = await build({ ...options, outDir: path.join(directory, "two") });
    expect(first.bundle.revision).toBe(second.bundle.revision);
    expect(first.bundle.revision).toBe(bundleRevision(first.bundle));
    expect(await Bun.file(path.join(directory, "one", first.manifest.objects.catalog.path)).text()).toBe(await Bun.file(path.join(directory, "two", second.manifest.objects.catalog.path)).text());
    expect(first.bundle.facts.length).toBe(6);
    expect(first.bundle.facts.every((fact) => fact.capability.state === "unknown")).toBe(true);
    expect(first.bundle.facts.find((fact) => fact.identity.request_model_id === "model-month")?.release).toMatchObject({ state: "known", value: { date: "2026-03", precision: "month", verified: false } });
    expect(first.coverage.inventory.provider_count).toBe(2);
    expect(first.bundle).not.toHaveProperty("raw_responses");
    expect(await Bun.file(path.join(directory, "one/reports/sources.json")).exists()).toBe(true);
    const firstPath = path.join(directory, "one", first.manifest.objects.catalog.path);
    const retained = await build({ ...options, sequence: 2, outDir: path.join(directory, "retained"), previousBundlePath: firstPath, openrouterSnapshotPath: path.join(directory, "missing-snapshot.json") });
    const previousP = first.bundle.facts.find((fact) => fact.popularity.state === "known")!;
    const retainedP = retained.bundle.facts.find((fact) => fact.identity.request_model_id === previousP.identity.request_model_id && fact.identity.provider === previousP.identity.provider)!;
    expect(retainedP.popularity).toEqual(previousP.popularity);
    expect(retained.bundle.source_revisions.find((source) => source.id === "openrouter-weekly")).toMatchObject({ status: "disabled", complete: true, retrieved_at: "2026-10-20T00:00:00Z", usage: { redistribution: "allowed" } });
  } finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
});

test("correction history cannot silently lose or rewrite a previous withdrawal", () => {
  const correction: Correction = { id: "withdraw-1", identity: { provider: "example", request_model_id: "a", scope: { route: "public", region: "global", plan: "public", protocol: "messages" } }, field: "release", action: "withdraw", reason: "Incorrect date", evidence: "Review fixture", reviewed_by: "reviewer", reviewed_at: "2026-10-20T00:00:00Z", sequence: 1 };
  expect(mergeCorrections([correction], [])).toEqual([correction]);
  expect(() => mergeCorrections([correction], [{ ...correction, reason: "Changed in place" }])).toThrow("Immutable correction");
});

test("a complete new weekly snapshot cannot compare historical positions from missing or wrong-scope identities", async () => {
  const root = await fixtureRoot();
  try {
    const options = { root, fixture: true, publishedAt: "2026-10-26T00:00:00Z", sequence: 1 };
    const first = await build({ ...options, outDir: path.join(root, "first") });
    const previous = structuredClone(first.bundle);
    const ranked = previous.facts.find(fact => fact.popularity.state === "known")!;
    const missing = structuredClone(ranked);
    missing.identity.request_model_id = "missing-from-current-snapshot";
    if (missing.popularity.state === "known") {
      missing.popularity.value.source_model_id = missing.identity.request_model_id;
      missing.popularity.value.position = 3;
    }
    const wrongScope = structuredClone(ranked);
    wrongScope.identity.provider = "historical-other-provider";
    previous.facts.push(missing, wrongScope);
    const previousPath = path.join(root, "previous.json");
    await Bun.write(previousPath, JSON.stringify(previous));
    const snapshotPath = path.join(root, "cogine/fixtures/openrouter-snapshot.json");
    const snapshot = await Bun.file(snapshotPath).json();
    snapshot.source.retrieved_at = "2026-10-26T00:00:00Z";
    await Bun.write(snapshotPath, JSON.stringify(snapshot));
    const next = await build({ ...options, sequence: 2, previousBundlePath: previousPath, outDir: path.join(root, "next") });
    for (const identity of [missing.identity, wrongScope.identity]) {
      const retained = next.bundle.facts.find(fact => fact.identity.provider === identity.provider && fact.identity.request_model_id === identity.request_model_id)!;
      expect(retained).toBeDefined();
      expect(retained.popularity).toMatchObject({ state: "unknown" });
    }
    expect(next.bundle.facts.filter(fact => fact.popularity.state === "known").every(fact => fact.popularity.state === "known" && fact.popularity.retrieved_at === snapshot.source.retrieved_at)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current source review revocation overrides both snapshot and previous catalog permissions", async () => {
  const root = await fixtureRoot();
  try {
    const options = { root, fixture: true, publishedAt: "2026-10-26T00:00:00Z", sequence: 1 };
    const first = await build({ ...options, outDir: path.join(root, "first") });
    const previousPath = path.join(root, "first", first.manifest.objects.catalog.path);
    const configPath = path.join(root, "cogine/fixtures/openrouter-config.json");
    const config = await Bun.file(configPath).json();
    config.usage = { collection: "disabled", redistribution: "disabled", evidence: "Synthetic review explicitly revokes both uses" };
    config.ranked_ids = [];
    config.ranking_evidence = "";
    await Bun.write(configPath, JSON.stringify(config));
    const partialPath = path.join(root, "partial.json");
    const partial = await Bun.file(path.join(root, "cogine/fixtures/openrouter-snapshot.json")).json();
    partial.source.status = "partial";
    partial.source.complete = false;
    partial.source.error = "Synthetic current attempt incomplete";
    partial.pagination.ended = false;
    await Bun.write(partialPath, JSON.stringify(partial));
    const states = [undefined, partialPath, path.join(root, "missing.json")];
    for (const [index, snapshotPath] of states.entries()) {
      const next = await build({ ...options, sequence: 2, previousBundlePath: previousPath, openrouterSnapshotPath: snapshotPath, outDir: path.join(root, `next-${index}`) });
      expect(next.bundle.source_revisions.find(source => source.id === "openrouter-weekly")?.usage).toEqual(config.usage);
      expect(next.bundle.attribution.some(entry => entry.source_id === "openrouter-weekly")).toBe(false);
      const retained = next.bundle.facts.filter(fact => fact.popularity.state === "known");
      expect(retained.length).toBeGreaterThan(0);
      expect(retained.every(fact => fact.popularity.state === "known" && !fact.popularity.value.ranking_eligible)).toBe(true);
      expect(() => assertPublishable({ ...next.bundle, fixture: false })).toThrow("rights");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a reviewed popularity replacement stays in history but cannot reintroduce an eligible position from an older snapshot", async () => {
  const root = await fixtureRoot();
  try {
    const options = { root, fixture: true, publishedAt: "2026-10-26T00:00:00Z", sequence: 1 };
    const first = await build({ ...options, outDir: path.join(root, "first") });
    const previousPath = path.join(root, "first", first.manifest.objects.catalog.path);
    const ranked = first.bundle.facts.find(fact => fact.popularity.state === "known" && fact.popularity.value.ranking_eligible)!;
    const correction: Correction = { id: "reviewed-old-position", identity: ranked.identity, field: "popularity", action: "replace", value: ranked.popularity, sequence: 1, reason: "Synthetic reviewed source association", evidence: "Synthetic exact input review", reviewed_by: "fixture", reviewed_at: "2026-10-20T00:00:00Z" };
    const correctionsPath = path.join(root, "cogine/fixtures/corrections.json");
    await Bun.write(correctionsPath, JSON.stringify([correction]));
    // A collector outage still retains this exact complete input and reviewed position.
    const retained = await build({ ...options, sequence: 2, previousBundlePath: previousPath, openrouterSnapshotPath: path.join(root, "missing.json"), outDir: path.join(root, "retained") });
    expect(retained.bundle.corrections).toEqual([correction]);
    expect(retained.bundle.facts.find(fact => fact.identity.request_model_id === ranked.identity.request_model_id && fact.identity.provider === ranked.identity.provider)?.popularity).toEqual(ranked.popularity);

    const currentSnapshotPath = path.join(root, "cogine/fixtures/openrouter-snapshot.json");
    const snapshot = await Bun.file(currentSnapshotPath).json();
    snapshot.source.retrieved_at = "2026-10-26T00:00:00Z";
    await Bun.write(currentSnapshotPath, JSON.stringify(snapshot));
    await expect(build({ ...options, sequence: 3, previousBundlePath: previousPath, outDir: path.join(root, "stale") })).rejects.toThrow("correction is stale");

    // An explicit higher review may preserve the old fact as historical, not current rank.
    const historical = structuredClone(ranked.popularity);
    if (historical.state !== "known") throw new Error("Expected known fixture position");
    historical.value.ranking_eligible = false;
    const superseding: Correction = { ...correction, id: "historical-position", sequence: 2, value: historical, reason: "Keep old evidence without comparing against the new input" };
    await Bun.write(correctionsPath, JSON.stringify([correction, superseding]));
    const next = await build({ ...options, sequence: 3, previousBundlePath: previousPath, outDir: path.join(root, "superseded") });
    expect(next.bundle.corrections).toEqual([correction, superseding]);
    expect(next.bundle.facts.find(fact => fact.identity.request_model_id === ranked.identity.request_model_id && fact.identity.provider === ranked.identity.provider)?.popularity).toEqual(historical);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a reviewed replacement cannot bypass revoked current item coverage or falsify the current snapshot position", async () => {
  const root = await fixtureRoot();
  try {
    const options = { root, fixture: true, publishedAt: "2026-10-26T00:00:00Z", sequence: 1 };
    const first = await build({ ...options, outDir: path.join(root, "first") });
    const ranked = first.bundle.facts.find(fact => fact.popularity.state === "known" && fact.popularity.value.ranking_eligible)!;
    const correction: Correction = { id: "reviewed-position", identity: ranked.identity, field: "popularity", action: "replace", value: ranked.popularity, sequence: 1, reason: "Synthetic reviewed association", evidence: "Synthetic review", reviewed_by: "fixture", reviewed_at: "2026-10-20T00:00:00Z" };
    const correctionsPath = path.join(root, "cogine/fixtures/corrections.json");
    await Bun.write(correctionsPath, JSON.stringify([correction]));
    const configPath = path.join(root, "cogine/fixtures/openrouter-config.json");
    const config = await Bun.file(configPath).json();
    await Bun.write(configPath, JSON.stringify({ ...config, ranked_ids: [] }));
    await expect(build({ ...options, outDir: path.join(root, "revoked") })).rejects.toThrow("no longer reviewed");

    await Bun.write(configPath, JSON.stringify(config));
    const wrongPosition = structuredClone(ranked.popularity);
    if (wrongPosition.state !== "known") throw new Error("Expected known fixture position");
    wrongPosition.value.position = 99;
    await Bun.write(correctionsPath, JSON.stringify([{ ...correction, value: wrongPosition }]));
    await expect(build({ ...options, outDir: path.join(root, "wrong-position") })).rejects.toThrow("correction is stale");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sparse publication excludes unusable N facts, retains audit identities and never hides supplied metrics", async () => {
  const raw = (await Bun.file("cogine/fixtures/upstream.json").json()).facts as ModelFacts[];
  expect(sparsePublicFacts(raw, [], [], "2026-10-26T00:00:00Z")).toHaveLength(3);
  const monthly = raw.find((fact) => fact.identity.request_model_id === "model-month")!;
  const mapping: Mapping = { id: "review-audit", from: monthly.identity, to: raw[0]!.identity, fields: ["popularity"], evidence: "Synthetic reviewed association", reviewed_by: "fixture", reviewed_at: "2026-10-20T00:00:00Z", status: "approved" };
  const included = sparsePublicFacts(raw, [mapping], [], "2026-10-26T00:00:00Z");
  expect(included.find((fact) => fact.identity.request_model_id === "model-month")?.release.state).toBe("unknown");
  expect(monthly.release).toMatchObject({ state: "known", value: { precision: "month", date: "2026-03" } });
  const suppliedP: ModelFacts = { ...monthly, popularity: { state: "known", source_id: "unapproved-source", value: { source_id: "unapproved-source", source_model_id: "x", position: 1, ranking_eligible: false }, retrieved_at: "2026-10-20T00:00:00Z", data_as_of: null, evidence: "Unapproved fixture metric must reach publisher rights gate" } };
  expect(sparsePublicFacts([suppliedP], [], [], "2026-10-26T00:00:00Z")[0]?.popularity).toEqual(suppliedP.popularity);
  const future = structuredClone(raw[0]!);
  if (future.release.state === "known") future.release.value.date = "2027-01-01";
  expect(sparsePublicFacts([future], [], [], "2026-10-26T00:00:00Z")).toHaveLength(0);
});
