import { join, resolve } from "node:path";
import { collectRankSources, RANK_SOURCE_IDS } from "./adapters/rank-sources.js";
import { openRankingInput, rankingInputReview, writeRankingInput, type RankingInput } from "./ranking-input.js";
import { observedPopularityPolicySchema } from "./observed-popularity.js";
import { atomicWrite, sha256, stableStringify } from "./integrity.js";
import { usageSchema } from "./schema.js";

export async function reviewedRankUsage(root: string) {
  const config = await Bun.file(join(root, "cogine/config/rank-sources.json")).json() as { schema_version: number; sources: Record<string, unknown> };
  if (config.schema_version !== 1) throw new Error("Unsupported ranking source policy");
  return new Map(Object.entries(config.sources).map(([id, usage]) => [id, usageSchema.parse(usage)]));
}
export async function collectRankings(options: { root?: string; stateDir?: string; outDir?: string; now?: string; fetcher?: typeof fetch } = {}) {
  const root = options.root ?? process.cwd(), now = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error("Invalid ranking collection clock");
  const previousPath = join(root, "cogine/data/rankings.json");
  const previous = await Bun.file(previousPath).exists() ? openRankingInput(await Bun.file(previousPath).json()) : undefined;
  const usage = await reviewedRankUsage(root);
  const policy = observedPopularityPolicySchema.parse(await Bun.file(join(root, "cogine/config/popularity-policy.json")).json());
  const disabledSourceIds = RANK_SOURCE_IDS.filter(id => usage.get(id)?.collection === "disabled");
  const result = await collectRankSources({ stateDir: resolve(options.stateDir ?? join(root, ".sync/rankings")), now, fetcher: options.fetcher, previousSnapshots: previous?.snapshots as any, previousCatalogs: previous?.catalogs as any, disabledSourceIds, usageOverrides: Object.fromEntries(usage), includeCatalogs: true });
  const snapshots = result.snapshots.map(snapshot => {
    const authority = usage.get(snapshot.source_id);
    if (!authority) throw new Error("Ranking source has no current reviewed usage policy");
    const { content_sha256: _oldContentHash, ...data } = snapshot;
    return { ...data, usage: authority };
  });
  const input: RankingInput = { schema_version: 1, evaluation_date: now.slice(0, 10), policy, snapshots, catalogs: result.catalogs };
  const outDir = resolve(options.outDir ?? join(root, ".sync/proposal"));
  const successful = result.attempts.some(attempt => attempt.kind === "ranking" && (attempt.status === "success" || attempt.status === "not_modified"));
  // An entirely failed round must not advance the reviewed window or erase facts.
  const effective = !successful && previous ? previous : input;
  const outputPath = join(outDir, "rankings.json");
  // Seed the output with the already reviewed envelope so unchanged content keeps
  // its exact ciphertext rather than creating a fresh nonce/data proposal.
  if (!await Bun.file(outputPath).exists() && await Bun.file(previousPath).exists()) await atomicWrite(outputPath, await Bun.file(previousPath).text());
  const written = await writeRankingInput(outputPath, effective);
  const report = { schema_version: 1, attempted_at: now, changed: written.changed, input_sha256: written.envelope.plaintext_sha256, encrypted_input_sha256: sha256(stableStringify(written.envelope)), review: rankingInputReview(effective), attempts: result.attempts.map(attempt => ({ kind: attempt.kind, source_id: attempt.source_id, status: attempt.status, attempted_at: attempt.attempted_at, retrieved_at: attempt.retrieved_at, complete_response: attempt.complete_response, changed: attempt.changed, retained_last_good: attempt.retained_last_good })), public_distribution_ready: snapshots.every(snapshot => snapshot.usage.redistribution === "allowed"), private_input: true };
  await atomicWrite(join(outDir, "collection.json"), stableStringify(report));
  return { input: effective, envelope: written.envelope, report, path: outputPath };
}
