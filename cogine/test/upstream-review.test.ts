import { expect, test } from "bun:test";
import { upstreamReleaseFact, type ReleaseVerification } from "../src/adapters/upstream.js";
import { identity, timestamp } from "./contract-fixture.js";

const provenance = { retrievedAt: timestamp, upstreamEvidence: "Pinned upstream authored date; not independently verified" };
const review: ReleaseVerification = { identity: identity(), date: "2026-01-15", precision: "day", evidence: "Reviewed official announcement", reviewed_by: "maintainer", reviewed_at: timestamp };

test("upstream date review applies only to the exact date and precision", () => {
  expect(upstreamReleaseFact("2026-01-15", review, provenance)).toMatchObject({ state: "known", value: { verified: true, version_specific: true }, evidence: review.evidence });
  expect(upstreamReleaseFact("2026-01-16", review, provenance)).toMatchObject({ state: "known", value: { date: "2026-01-16", verified: false, version_specific: false }, evidence: provenance.upstreamEvidence });
  expect(upstreamReleaseFact("2026-01-15", { ...review, precision: "month" }, provenance)).toMatchObject({ state: "known", value: { verified: false, version_specific: false }, evidence: provenance.upstreamEvidence });
  expect(upstreamReleaseFact("2026-01-15", undefined, provenance)).toMatchObject({ state: "known", value: { verified: false, version_specific: false }, evidence: provenance.upstreamEvidence });
});

test("missing and invalid upstream dates stay unknown; reviewed month precision is preserved", () => {
  expect(upstreamReleaseFact(undefined, review, provenance).state).toBe("unknown");
  expect(upstreamReleaseFact("2026-02-30", review, provenance).state).toBe("unknown");
  expect(upstreamReleaseFact("2026-01", { ...review, date: "2026-01", precision: "month" }, provenance)).toMatchObject({ state: "known", value: { date: "2026-01", precision: "month", verified: true, version_specific: true }, evidence: review.evidence });
});
