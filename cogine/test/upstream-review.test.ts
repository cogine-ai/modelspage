import { expect, test } from "bun:test";
import { loadUpstream, upstreamReleaseFact, type ReleaseVerification } from "../src/adapters/upstream.js";
import { sparsePublicFacts } from "../src/build.js";
import { trustedRelease } from "../src/projection.js";
import { identity, timestamp } from "./contract-fixture.js";

const provenance = { retrievedAt: timestamp, upstreamEvidence: "Pinned models.dev resolved release_date; trusted upstream data without an independent local date audit" };
const review: ReleaseVerification = { identity: identity(), date: "2026-01-15", precision: "day", evidence: "Reviewed official announcement", reviewed_by: "maintainer", reviewed_at: timestamp };

test("valid upstream release dates enter N without a local review whitelist", () => {
  const fact = upstreamReleaseFact("2026-01-15", undefined, provenance);
  expect(fact).toMatchObject({ state: "known", value: { date: "2026-01-15", verified: true, version_specific: true }, evidence: provenance.upstreamEvidence });
  expect(trustedRelease(fact, timestamp)).toBe("2026-01-15");
});

test("supplementary evidence applies only to the exact date and precision without downgrading upstream", () => {
  const reviewed = upstreamReleaseFact("2026-01-15", review, provenance);
  expect(reviewed).toMatchObject({ state: "known", value: { verified: true, version_specific: true } });
  if (reviewed.state === "known") {
    expect(reviewed.evidence).toContain(provenance.upstreamEvidence);
    expect(reviewed.evidence).toContain(review.evidence);
  }
  expect(upstreamReleaseFact("2026-01-16", review, provenance)).toMatchObject({ state: "known", value: { date: "2026-01-16", verified: true, version_specific: true }, evidence: provenance.upstreamEvidence });
  expect(upstreamReleaseFact("2026-01-15", { ...review, precision: "month" }, provenance)).toMatchObject({ state: "known", value: { verified: true, version_specific: true }, evidence: provenance.upstreamEvidence });
});

test("missing and invalid dates stay unknown; month/year precision and future exclusion are preserved", () => {
  expect(upstreamReleaseFact(undefined, review, provenance).state).toBe("unknown");
  expect(upstreamReleaseFact("2026-02-30", review, provenance).state).toBe("unknown");
  for (const [date, precision] of [["2026-01", "month"], ["2026", "year"], ["2027-01-01", "day"]] as const) {
    const fact = upstreamReleaseFact(date, undefined, provenance);
    expect(fact).toMatchObject({ state: "known", value: { date, precision, verified: true, version_specific: true } });
    expect(trustedRelease(fact, timestamp)).toBeUndefined();
  }
});

test("pinned upstream direct and resolved alias dates survive sparse publication without reviews", async () => {
  const upstream = await loadUpstream(process.cwd());
  const published = sparsePublicFacts(upstream.facts, [], [], timestamp);
  for (const [provider, modelId, date] of [["openai", "gpt-4o-2024-08-06", "2024-08-06"], ["anthropic", "claude-sonnet-4-5", "2025-09-29"]]) {
    const fact = published.find((entry) => entry.identity.provider === provider && entry.identity.request_model_id === modelId);
    expect(fact).toBeDefined();
    expect(fact?.release).toMatchObject({ state: "known", value: { date, precision: "day", verified: true, version_specific: true } });
    expect(trustedRelease(fact!.release, timestamp)).toBe(date);
    if (fact!.release.state === "known") expect(fact!.release.evidence).toContain(upstream.source.code_commit!);
  }
}, 30_000);
