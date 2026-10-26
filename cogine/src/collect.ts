import path from "node:path";
import { atomicWrite, stableStringify } from "./integrity.js";
import { fetchOpenRouter, OpenRouterConfig, validateOpenRouterSnapshot, type OpenRouterSnapshot } from "./adapters/openrouter.js";

export type CollectOptions = { probe?: boolean; fixture?: boolean; now?: string; statePath?: string; reportPath?: string; fetcher?: typeof fetch; root?: string };
export async function collectOpenRouter(options: CollectOptions = {}): Promise<OpenRouterSnapshot> {
  const root = options.root ?? process.cwd();
  const statePath = options.statePath ?? path.join(root, ".sync/openrouter.json");
  const now = options.now ?? new Date().toISOString();
  let snapshot: OpenRouterSnapshot;
  if (options.fixture) {
    snapshot = validateOpenRouterSnapshot(await Bun.file(path.join(root, "cogine/fixtures/openrouter-snapshot.json")).json());
  } else {
    const configuration = OpenRouterConfig.parse(await Bun.file(path.join(root, "cogine/config/openrouter.json")).json());
    let previous: OpenRouterSnapshot | undefined;
    if (await Bun.file(statePath).exists()) previous = validateOpenRouterSnapshot(await Bun.file(statePath).json());
    snapshot = await fetchOpenRouter(configuration, { now, previous, probe: options.probe, fetcher: options.fetcher });
  }
  // Keep the durable last-good input byte-for-byte on unchanged/disabled/failure.
  // Attempt status/time belongs in the operational report, not a new data revision.
  if (options.fixture || snapshot.source.status === "success") await atomicWrite(statePath, stableStringify(snapshot));
  const reportPath = options.reportPath ?? path.join(root, "dist/reports/collection.json");
  await atomicWrite(reportPath, stableStringify({ source: snapshot.source, attempted_at: snapshot.attempted_at, pagination: snapshot.pagination, retained_last_good: snapshot.retained_last_good, entry_count: snapshot.entries.length, ranking_eligible_count: snapshot.entries.filter((entry) => entry.ranking_eligible).length, fixture: !!options.fixture }));
  return snapshot;
}
