import { describe, expect, test } from "bun:test";
import { applyCorrections } from "../src/corrections.js";
import { verifyReleaseBytes } from "../src/publish.js";
import { validateBundle, validateManifest } from "../src/schema.js";
import { bundle, capability, identity, model, release, seal, timestamp } from "./contract-fixture.js";

describe("public data contract", () => {
  test("committed positive and negative JSON examples exercise public contracts", async () => {
    const root = "cogine/fixtures/contracts/";
    const catalogText = await Bun.file(root + "valid-catalog.json").text();
    const manifest = await Bun.file(root + "valid-manifest.json").json();
    validateBundle(JSON.parse(catalogText));
    validateManifest(manifest);
    verifyReleaseBytes(manifest, catalogText);
    expect(() => verifyReleaseBytes(manifest, catalogText + " ")).toThrow("hash or size");
    expect(() => verifyReleaseBytes({ ...manifest, objects: { catalog: { ...manifest.objects.catalog, sha256: "0".repeat(64) } } }, catalogText)).toThrow("hash or size");
    for (const name of ["invalid-request-id.json", "invalid-null-state.json"]) {
      const invalid = await Bun.file(root + name).json();
      expect(() => validateBundle(invalid)).toThrow();
    }
    const incompatible = await Bun.file(root + "invalid-schema-version.json").json();
    expect(() => validateManifest(incompatible)).toThrow();
  });
  test("strict schema preserves explicit unknown, conflict and withdrawal states", () => {
    const correction = { id: "withdraw", identity: identity(), field: "release" as const, action: "withdraw" as const, reason: "Wrong date", evidence: "Review", reviewed_by: "maintainer", reviewed_at: timestamp, sequence: 1 };
    const input = bundle({ corrections: [correction] });
    input.facts = applyCorrections(input.facts, input.corrections);
    expect(validateBundle(input).facts[0]!.release.state).toBe("withdrawn");
    expect(() => validateBundle({ ...input, execution_url: "https://bad.invalid" })).toThrow();
    expect(() => validateBundle({ ...input, facts: [{ ...input.facts[0], release: null }] })).toThrow();
  });
  test("keeps month precision and rejects fabricated/invalid calendar dates", () => {
    expect(validateBundle(bundle({ facts: [model("m", { release: release("2026-10", { precision: "month" }) })] })).facts[0]!.release.state).toBe("known");
    expect(() => validateBundle(bundle({ facts: [model("m", { release: release("2026-02-30") })] }))).toThrow();
    expect(() => validateBundle(bundle({ facts: [model("m", { release: release("2026-10-01", { precision: "month" }) })] }))).toThrow();
  });
  test("rejects duplicate exact identities, dangling source/profile, wrong inference config", () => {
    expect(() => validateBundle(bundle({ facts: [model(), model()] }))).toThrow("Duplicate");
    expect(() => validateBundle(bundle({ source_revisions: [] }))).toThrow("source");
    expect(() => validateBundle(bundle({ facts: [model("m", { capability: capability(0, "missing") })] }))).toThrow("profile");
    expect(() => validateBundle(bundle({ facts: [model("m", { capability: capability(0, "fixture-profile", "reasoning=high") })] }))).toThrow("configuration");
  });
  test("latest failed source may retain genuine old facts and timestamps", () => {
    const input = bundle();
    input.source_revisions[0]!.status = "failed";
    input.source_revisions[0]!.complete = false;
    input.source_revisions[0]!.retrieved_at = "2026-10-26T00:00:00.000Z";
    const output = validateBundle(input);
    expect(output.facts[0]!.release).toMatchObject({ retrieved_at: timestamp, data_as_of: null });
  });
  test("manifest binds one revision and forbids unknown structure", () => {
    const { manifest } = seal();
    expect(validateManifest(manifest)).toEqual(manifest);
    expect(() => validateManifest({ ...manifest, schema_version: 2 })).toThrow();
    expect(() => validateManifest({ ...manifest, revision: "f".repeat(64) })).toThrow("mismatch");
  });
  test("correction can move release earlier and withdrawal survives missing upstream row", () => {
    const correction = { id: "earlier", identity: identity(), field: "release" as const, action: "replace" as const, value: release("2020-01-01"), reason: "First release was earlier", evidence: "Official changelog", reviewed_by: "maintainer", reviewed_at: timestamp, sequence: 1 };
    const updated = applyCorrections([model()], [correction]);
    expect(updated[0]!.release).toMatchObject({ state: "known", value: { date: "2020-01-01" } });
    const withdrawn = applyCorrections([], [{ ...correction, id: "gone", action: "withdraw", value: undefined, sequence: 2 }]);
    expect(withdrawn[0]!.release.state).toBe("withdrawn");
    expect(() => applyCorrections([model()], [correction, { ...correction, id: "collision" }])).toThrow("same field sequence");
    expect(() => validateBundle(bundle({ corrections: [correction] }))).toThrow("latest reviewed correction");
  });
});
