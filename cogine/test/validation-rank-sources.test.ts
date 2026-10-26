import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoCredentialEcho, persistSnapshot, type RankSourceSnapshot } from "../scripts/validation/rank-sources.js";

function snapshot(): RankSourceSnapshot {
  return { schema_version: 1, source_id: "test-source", attempted_at: "2026-10-26T00:00:00Z", retrieved_at: "2026-10-25T00:00:00Z", data_as_of: "2026-10-24T00:00:00Z", data_as_of_precision: "timestamp", status: "success", complete_response: true, coverage_truncated: false, cutoff: "test", scope: "test", window: { start: null, end: null, label: "test" }, usage: { collection: "diagnostic_only", redistribution: "unverified", evidence: "test" }, authentication_provided: false, endpoints: [], raw_files: [], entries: [{ source_model_id: "model", metric: "tokens", value: "7", value_unit: "tokens" }], issues: [], metadata: {} };
}

describe("validation source security and retention", () => {
  test("checks dynamically configured credentials and JSON-decoded strings/keys", () => {
    const previous = process.env.MODELSPAGE_AA_API_KEY;
    process.env.MODELSPAGE_AA_API_KEY = "fixture-credential-do-not-save";
    try {
      expect(() => assertNoCredentialEcho("safe response")).not.toThrow();
      expect(() => assertNoCredentialEcho({ nested: ["fixture-credential-do-not-save"] })).toThrow("response body discarded");
      const escaped = '{"nested":"fixture\\u002dcredential-do-not-save"}';
      expect(() => assertNoCredentialEcho(escaped)).not.toThrow();
      expect(() => assertNoCredentialEcho(JSON.parse(escaped))).toThrow("response body discarded");
      expect(() => assertNoCredentialEcho({ "fixture-credential-do-not-save": true })).toThrow("response body discarded");
    } finally { if (previous === undefined) delete process.env.MODELSPAGE_AA_API_KEY; else process.env.MODELSPAGE_AA_API_KEY = previous; }
  });

  test("failed and partial attempts preserve last-good values and freshness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "modelspage-rank-retention-"));
    try {
      const good = snapshot();
      await persistSnapshot(directory, good);
      const goodBody = await Bun.file(join(directory, "test-source/last-good.json")).text();
      const failure = { ...snapshot(), attempted_at: "2026-10-26T01:00:00Z", retrieved_at: null, data_as_of: null, status: "failed" as const, complete_response: false, entries: [] };
      await persistSnapshot(directory, failure);
      expect(await Bun.file(join(directory, "test-source/last-good.json")).text()).toBe(goodBody);
      expect((await Bun.file(join(directory, "test-source/snapshot.json")).json()).metadata.last_good_retained.retrieved_at).toBe(good.retrieved_at);
      const partial = { ...failure, attempted_at: "2026-10-26T02:00:00Z", status: "partial" as const, entries: good.entries };
      await persistSnapshot(directory, partial);
      expect(await Bun.file(join(directory, "test-source/last-good.json")).text()).toBe(goodBody);
      expect((await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: join(directory, "test-source/history") }))).length).toBe(3);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
