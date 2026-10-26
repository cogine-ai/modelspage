import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProductionCandidate, publicationPlan, readActiveRelease } from "../scripts/production.js";
import { applyCorrections } from "../src/corrections.js";
import { assertInitialCpnReadiness } from "../src/readiness.js";
import { unknown, type Bundle } from "../src/types.js";
import { bundle, capability, identity, model, popularity, release, seal, timestamp } from "./contract-fixture.js";

function complete(overrides: Partial<Bundle> = {}) {
  return bundle({ fixture: false, facts: [model("model-v1", { capability: capability(90), popularity: popularity(1) })], ...overrides });
}
const sealed = (input: Bundle) => { const value = seal(input); return { ...value, catalogBody: value.catalog }; };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("initial production readiness", () => {
  test("requires usable C, P and N rather than profiles or known-but-ineligible facts", () => {
    expect(assertInitialCpnReadiness(complete())).toEqual({ capability: 1, popularity: 1, newest: 1 });
    const noCapability = complete(); noCapability.facts[0]!.capability = unknown("No comparable measurement");
    expect(() => assertInitialCpnReadiness(noCapability)).toThrow("missing: capability");
    const noPopularity = complete(); noPopularity.facts[0]!.popularity = popularity(1, "fixture-entry", false);
    expect(() => assertInitialCpnReadiness(noPopularity)).toThrow("missing: popularity");
    const incomplete = complete(); incomplete.source_revisions[0]!.complete = false;
    expect(() => assertInitialCpnReadiness(incomplete)).toThrow("missing: popularity");
  });
  test("requires trusted dates, comparable profiles, distribution terms and fixture rejection", () => {
    for (const value of [release("2026-10", { precision: "month" }), release("2026-10-26"), release("2026-10-01", { verified: false }), release("2026-10-01", { version_specific: false })]) {
      const input = complete(); input.facts[0]!.release = value;
      expect(() => assertInitialCpnReadiness(input)).toThrow("missing: newest");
    }
    const unmatchedProfile = complete(); unmatchedProfile.metric_profiles[0]!.inference_config = "different";
    expect(() => assertInitialCpnReadiness(unmatchedProfile)).toThrow("exact profile");
    const unlicensed = complete(); unlicensed.source_revisions[0]!.usage.redistribution = "unverified";
    expect(() => assertInitialCpnReadiness(unlicensed)).toThrow("missing: capability, popularity, newest");
    const profileTerms = complete(); profileTerms.metric_profiles[0]!.usage.redistribution = "unverified";
    expect(() => assertInitialCpnReadiness(profileTerms)).toThrow("missing: capability");
    expect(() => assertInitialCpnReadiness(complete({ fixture: true }))).toThrow("Synthetic");
  });
  test("stopping collection does not revoke distribution of existing permitted data", () => {
    const input = complete();
    input.source_revisions[0]!.usage.collection = "disabled";
    input.metric_profiles[0]!.usage.collection = "disabled";
    expect(assertInitialCpnReadiness(input)).toEqual({ capability: 1, popularity: 1, newest: 1 });
  });
  test("reviewed identity conflicts override exact known facts for readiness", () => {
    const input = complete({ mappings: [{ id: "conflict", from: identity(), to: identity(), fields: ["capability"], evidence: "Synthetic review", reviewed_by: "test", reviewed_at: timestamp, status: "conflict" }] });
    expect(() => assertInitialCpnReadiness(input)).toThrow("missing: capability");
  });
  test("an established production version may publish a safe withdrawal without C evidence", () => {
    const previous = sealed(complete());
    const input = complete({ publication_sequence: 2, corrections: [{ id: "revoke", identity: identity(), field: "capability", action: "withdraw", reason: "Evidence revoked", evidence: "Synthetic test review", reviewed_by: "test", reviewed_at: timestamp, sequence: 1 }] });
    input.facts = applyCorrections(input.facts, input.corrections);
    const next = sealed(input);
    expect(() => checkProductionCandidate(next, null)).toThrow("missing: capability");
    expect(checkProductionCandidate(next, previous)).toEqual({ initial_publication: false });
    expect(() => checkProductionCandidate(sealed(complete({ publication_sequence: 3 })), next)).toThrow("withdrawal");
    expect(() => checkProductionCandidate(previous, previous)).toThrow("advance");
    expect(() => checkProductionCandidate(next, sealed(complete({ fixture: true })))).toThrow("fixture");
  });
});

describe("fixed production publication plan", () => {
  test("derives sequence from the verified current manifest and uses a fixed commit clock", () => {
    const commitTime = "2026-10-26T08:00:00+08:00";
    expect(publicationPlan(null, commitTime)).toEqual({ sequence: 1, published_at: "2026-10-26T00:00:00.000Z", has_previous: false });
    const previous = sealed(complete()).manifest;
    expect(publicationPlan(previous, commitTime)).toEqual({ sequence: 2, published_at: "2026-10-26T00:00:00.000Z", has_previous: true });
    expect(publicationPlan(previous, "2026-01-01T00:00:00Z").published_at).toBe(previous.published_at);
    expect(() => publicationPlan(previous, "today")).toThrow();
    expect(() => publicationPlan({ ...previous, publication_sequence: Number.MAX_SAFE_INTEGER }, commitTime)).toThrow("exhausted");
    expect(() => publicationPlan({ ...previous, fixture: true }, commitTime)).toThrow("fixture");
  });
  test("a partial or corrupt persisted current release cannot become a first publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "modelspage-active-")); directories.push(directory);
    expect(await readActiveRelease(directory)).toBeNull();
    const previous = sealed(complete());
    await writeFile(join(directory, "manifest.json"), JSON.stringify(previous.manifest));
    await expect(readActiveRelease(directory)).rejects.toThrow("Incomplete");
    await writeFile(join(directory, "catalog.json"), previous.catalogBody + " ");
    await expect(readActiveRelease(directory)).rejects.toThrow("hash");
    await writeFile(join(directory, "catalog.json"), previous.catalogBody);
    expect((await readActiveRelease(directory))!.manifest).toEqual(previous.manifest);
  });
});
