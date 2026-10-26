import { expect, test } from "bun:test";
import { assertSafeReplacement, verifyRelease } from "../src/client.js";
import { applyCorrections } from "../src/corrections.js";
import { publishRelease, rollbackRelease } from "../src/publish.js";
import { MemoryStore } from "../src/store.js";
import type { Correction } from "../src/types.js";
import { bundle, identity, release, seal, timestamp } from "./contract-fixture.js";

function corrected(sequence = 2, correctionSequence = 1, date = "2020-01-01") {
  const correction: Correction = { id: `reviewed-date-${correctionSequence}`, identity: identity(), field: "release", action: "replace", value: release(date), sequence: correctionSequence, reason: "Reviewed first release date", evidence: "Official announcement", reviewed_by: "maintainer", reviewed_at: timestamp };
  const input = bundle({ publication_sequence: sequence, corrections: [correction] });
  input.facts = applyCorrections(input.facts, input.corrections);
  return seal(input);
}
test("publisher rollback must preserve a reviewed replacement or explicitly supersede it", async () => {
  const store = new MemoryStore();
  const original = seal(); const fixed = corrected();
  await publishRelease(store, { ...original, catalogBody: original.catalog }, { allowFixture: true });
  await publishRelease(store, { ...fixed, catalogBody: fixed.catalog }, { allowFixture: true });
  await expect(publishRelease(store, rollbackRelease({ ...original, catalogBody: original.catalog }, 3, timestamp), { allowFixture: true })).rejects.toThrow("correction");
  const superseded = corrected(3, 2, "2019-01-01");
  expect((await publishRelease(store, { ...superseded, catalogBody: superseded.catalog }, { allowFixture: true })).status).toBe("published");
});
test("consumer refuses higher-sequence rollback or packaged data that loses a replacement", async () => {
  const fixed = corrected();
  const previous = await verifyRelease(fixed.manifest, async () => fixed.catalog);
  const original = seal(bundle({ publication_sequence: 3 }));
  const rolledBack = await verifyRelease(original.manifest, async () => original.catalog);
  expect(() => assertSafeReplacement(previous, rolledBack)).toThrow("correction");
  const superseded = corrected(3, 2, "2019-01-01");
  const next = await verifyRelease(superseded.manifest, async () => superseded.catalog);
  expect(() => assertSafeReplacement(previous, next)).not.toThrow();
});
