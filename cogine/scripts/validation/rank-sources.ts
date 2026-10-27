import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { collectRankSources, RANK_SOURCE_IDS, type RankSourceId } from "../../src/adapters/rank-sources.js";

// Compatibility entry point; collection, parsing and durable state have one owner.
export * from "../../src/adapters/rank-sources.js";

async function main() {
  const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { "out-dir": { type: "string" }, only: { type: "string" }, now: { type: "string" }, catalogs: { type: "boolean", default: false }, "anonymous-openrouter-catalog": { type: "boolean", default: false } } });
  const ids = values.only?.split(",");
  if (ids?.some(id => !RANK_SOURCE_IDS.includes(id as RankSourceId))) throw new Error("Unknown --only ranking source ID");
  const result = await collectRankSources({ stateDir: resolve(values["out-dir"] ?? ".modelspage/full-validation/sources"), sourceIds: ids as RankSourceId[] | undefined, now: values.now, includeCatalogs: values.catalogs, anonymousCatalogDiagnostic: values["anonymous-openrouter-catalog"] });
  console.log(JSON.stringify({ sources: result.snapshots.map(snapshot => ({ source_id: snapshot.source_id, status: snapshot.status, entries: snapshot.entries.length, retrieved_at: snapshot.retrieved_at, data_as_of: snapshot.data_as_of })), attempts: result.attempts, catalogs: result.catalogs.map(catalog => ({ source_id: catalog.source_id, entries: catalog.entries.length, sha256: catalog.sha256 })) }));
}
if (import.meta.main) main().catch(() => { console.error("Ranking source collection failed; no configured credential is included in this message"); process.exitCode = 1; });
