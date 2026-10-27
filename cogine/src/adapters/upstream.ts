import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateV2 } from "../../../packages/core/src/generate-v2.js";
import { identityKey, unknown, type Identity, type ModelFacts, type SourceRevision } from "../types.js";
import { sha256, stableStringify } from "../integrity.js";
import { validCalendarDate } from "../schema.js";
import type { MetricIdentityRow } from "../metric-identity.js";

export type ReleaseVerification = { identity: Identity; date: string; precision: "day" | "month" | "year"; evidence: string; reviewed_by: string; reviewed_at: string };
export type UpstreamInput = { facts: ModelFacts[]; source: SourceRevision; providerIds: string[]; registryRows: MetricIdentityRow[] };
export const MODELS_DEV_USAGE = { collection: "allowed", redistribution: "allowed", evidence: "Repository LICENSE (MIT), retained verbatim; applies to inherited catalog/code, not third-party metric data." } as const;

export function releasePrecision(date: string): "day" | "month" | "year" | undefined {
  for (const precision of ["day", "month", "year"] as const) if (validCalendarDate(date, precision)) return precision;
  return undefined;
}

export function upstreamReleaseFact(date: string | undefined, review: ReleaseVerification | undefined, provenance: { retrievedAt: string; upstreamEvidence: string }): ModelFacts["release"] {
  const precision = date ? releasePrecision(date) : undefined;
  if (!date || !precision) return unknown("Upstream has no calendar-valid release date with preserved precision");
  const reviewApplies = !!review && review.date === date && review.precision === precision;
  return {
    // Trust the pinned upstream's resolved date for this record. These flags describe
    // source trust/applicability, not an independent local audit of every model.
    state: "known", value: { date, precision, verified: true, version_specific: true },
    source_id: "models-dev", retrieved_at: provenance.retrievedAt, data_as_of: null,
    evidence: reviewApplies ? `${provenance.upstreamEvidence}; supplementary review: ${review.evidence}` : provenance.upstreamEvidence,
  };
}

export async function loadUpstream(root: string, verifications: ReleaseVerification[] = []): Promise<UpstreamInput> {
  const lock = await Bun.file(path.join(root, "cogine/upstream.lock.json")).json() as { commit: string; imported_at: string; synced_at?: string; repository: string };
  const retrievedAt = lock.synced_at ?? lock.imported_at;
  if (!/^[a-f0-9]{40}$/.test(lock.commit)) throw new Error("Invalid pinned upstream commit");
  const codeRoot = fileURLToPath(new URL("../../../", import.meta.url));
  if (path.resolve(codeRoot) !== path.resolve(root)) {
    const expected = Bun.spawnSync(["git", "rev-parse", `${lock.commit}:packages/core`], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const running = Bun.spawnSync(["git", "rev-parse", "HEAD:packages/core"], { cwd: codeRoot, stdout: "pipe", stderr: "pipe" });
    const unchanged = Bun.spawnSync(["git", "diff", "--quiet", "HEAD", "--", "packages/core"], { cwd: codeRoot, stdout: "pipe", stderr: "pipe" });
    if (expected.exitCode || running.exitCode || unchanged.exitCode || new TextDecoder().decode(expected.stdout) !== new TextDecoder().decode(running.stdout)) throw new Error("Trusted running parser differs from candidate pin; review upstream parser changes before building with ranking credentials");
  }
  const result = Bun.spawnSync(["git", "diff", "--quiet", lock.commit, "--", "models", "providers", "packages/core"], { cwd: root });
  if (result.exitCode !== 0) throw new Error("Upstream input differs from pinned commit; review/update upstream.lock.json before building");
  const untracked = Bun.spawnSync(["git", "ls-files", "--others", "--exclude-standard", "--", "models", "providers", "packages/core"], { cwd: root });
  if (untracked.exitCode !== 0 || new TextDecoder().decode(untracked.stdout).trim()) throw new Error("Untracked upstream input cannot be attributed to the pinned commit");
  const tree = Bun.spawnSync(["git", "rev-parse", `${lock.commit}:models`, `${lock.commit}:providers`, `${lock.commit}:packages/core`], { cwd: root });
  if (tree.exitCode !== 0) throw new Error("Pinned upstream objects missing");
  const source: SourceRevision = { id: "models-dev", status: "success", code_commit: lock.commit, url: lock.repository, retrieved_at: retrievedAt, data_as_of: null, sha256: sha256(tree.stdout), window: { start: null, end: null }, usage: MODELS_DEV_USAGE, complete: true };
  const providers = await generateV2(path.join(root, "providers"));
  const supplementaryReviews = new Map(verifications.map((entry) => [identityKey(entry.identity), entry]));
  const facts: ModelFacts[] = [];
  const registryRows: MetricIdentityRow[] = [];
  const weightsByCanonical = new Map<string, { url: string }[]>();
  for (const providerId of Object.keys(providers).sort()) {
    const provider = providers[providerId]!;
    for (const modelId of Object.keys(provider.models).sort()) {
      const model = provider.models[modelId]!;
      const authoredPath = path.join(root, "providers", providerId, "models", `${modelId}.toml`);
      const authored = Bun.TOML.parse(await Bun.file(authoredPath).text()) as { base_model?: string; release_date?: string };
      const canonicalId = model.canonical_id ?? authored.base_model;
      if (canonicalId && !weightsByCanonical.has(canonicalId)) {
        const lab = Bun.file(path.join(root, "models", `${canonicalId}.toml`));
        const metadata = await lab.exists() ? Bun.TOML.parse(await lab.text()) as { weights?: { url: string }[] } : null;
        weightsByCanonical.set(canonicalId, metadata?.weights ?? []);
      }
      registryRows.push({ provider_id: providerId, id: modelId, name: model.name, canonical_id: canonicalId, weights: canonicalId ? weightsByCanonical.get(canonicalId) : [] });
      for (const protocol of Object.keys(model.api).sort()) {
        const identity: Identity = { provider: providerId, request_model_id: modelId, scope: { route: "public", region: "global", plan: "public", protocol } };
        const review = supplementaryReviews.get(identityKey(identity));
        const date = model.release_date;
        // Canonical association is retained as metadata. It grants no field inheritance to clients.
        // models.dev owns base-model resolution and each record's release_date semantics.
        const release = upstreamReleaseFact(date, review, { retrievedAt, upstreamEvidence: `${lock.repository}/blob/${lock.commit}/providers/${providerId}/models/${modelId}.toml (release_date resolved by the pinned models.dev parser; trusted as upstream-maintained data, without an independent local date audit)` });
        facts.push({ identity, display_name: model.name, ...(canonicalId ? { canonical_id: canonicalId } : {}), release, capability: unknown("No comparable capability source observation"), popularity: unknown("No observed popularity source evidence") });
      }
    }
  }
  return { facts, source, providerIds: Object.keys(providers).sort(), registryRows };
}

export async function loadFixtureUpstream(root: string): Promise<UpstreamInput> {
  const fixture = await Bun.file(path.join(root, "cogine/fixtures/upstream.json")).json() as { facts: ModelFacts[] };
  const digest = sha256(stableStringify(fixture));
  return { facts: fixture.facts, registryRows: fixture.facts.map(fact => ({ provider_id: fact.identity.provider, id: fact.identity.request_model_id, name: fact.display_name, canonical_id: fact.canonical_id })), providerIds: [...new Set(fixture.facts.map((fact) => fact.identity.provider))].sort(), source: { id: "models-dev", status: "success", code_commit: "0000000000000000000000000000000000000000", url: "https://fixtures.invalid/models-dev", retrieved_at: "2026-10-20T00:00:00Z", data_as_of: null, sha256: digest, window: { start: null, end: null }, usage: { collection: "allowed", redistribution: "allowed", evidence: "Synthetic fixtures authored for tests; not production model facts" }, complete: true } };
}
