import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build, mergeCorrections, sparsePublicFacts } from "../src/build.js";
import type { Correction, ModelFacts, Mapping } from "../src/types.js";
import { bundleRevision } from "../src/integrity.js";

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

test("sparse publication excludes raw-unverified catalog rows, retains audit identities and never hides supplied metrics", async () => {
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
