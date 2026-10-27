import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { build } from "./build.js";
import { collectOpenRouter } from "./collect.js";
import { stableStringify } from "./integrity.js";
import { publishRelease, publicVerifier, readRelease, rollbackRelease } from "./publish.js";
import { configuredR2Store, DirectoryStore } from "./store.js";
import { seedCurrentRelease } from "./active.js";
import { collectRankings } from "./ranking-collect.js";

async function main() {
  const { positionals, values } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, strict: true, options: {
    fixture: { type: "boolean" }, "dry-run": { type: "boolean" }, probe: { type: "boolean" },
    "published-at": { type: "string" }, sequence: { type: "string" }, "out-dir": { type: "string" },
    input: { type: "string" }, root: { type: "string" }, "state-dir": { type: "string" }, previous: { type: "string" },
    snapshot: { type: "string" }, "rankings-input": { type: "string" }, "state-path": { type: "string" }, "report-path": { type: "string" }, now: { type: "string" }, "public-base-url": { type: "string" }
  } });
  const command = positionals[0];
  const sequence = Number(values.sequence);
  if (command === "build" || command === "coverage") {
    if (!values["published-at"] || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Build requires explicit --published-at ISO and --sequence positive-integer (use bun run build:fixture for an offline example)");
    const result = await build({ fixture: values.fixture, publishedAt: values["published-at"], sequence, outDir: resolve(values["out-dir"] ?? "dist/public"), root: values.root ? resolve(values.root) : undefined, previousBundlePath: values.previous, openrouterSnapshotPath: values.snapshot, rankingsInputPath: values["rankings-input"] });
    console.log(stableStringify({ revision: result.bundle.revision, sequence: result.manifest.publication_sequence, fixture: result.bundle.fixture, output: resolve(values["out-dir"] ?? "dist/public"), ...(command === "coverage" ? { coverage: result.coverage } : {}) }).trim());
  } else if (command === "fetch-current") {
    const base = values["public-base-url"] ?? process.env.MODELSPAGE_PUBLIC_BASE_URL;
    if (!base) throw new Error("fetch-current requires MODELSPAGE_PUBLIC_BASE_URL or --public-base-url");
    const previousPath = await seedCurrentRelease(base, resolve(values["out-dir"] ?? ".modelspage/active"));
    console.log(stableStringify({ active: !!previousPath, previous_path: previousPath }).trim());
  } else if (command === "collect-rankings") {
    const result = await collectRankings({ now: values.now, stateDir: values["state-dir"], outDir: values["out-dir"] });
    console.log(stableStringify({ status: "completed", private_input: true, changed: result.report.changed, sources: result.report.attempts }).trim());
  } else if (command === "collect") {
    const snapshot = await collectOpenRouter({ probe: values.probe, fixture: values.fixture, now: values.now, statePath: values["state-path"], reportPath: values["report-path"] });
    // Never print raw response or source credentials.
    console.log(stableStringify({ source: "openrouter", status: snapshot.source.status, complete: snapshot.source.complete, retrieved_at: snapshot.source.retrieved_at }).trim());
  } else if (command === "validate") {
    const release = await readRelease(resolve(values.input ?? "dist/fixture"));
    console.log(`Validated schema, revision, object hash and size: ${release.manifest.revision}`);
  } else if (command === "publish" || command === "rollback") {
    let release = await readRelease(resolve(values.input ?? "dist/fixture"));
    if (command === "rollback") {
      if (!values["published-at"]) throw new Error("Rollback requires --published-at and --sequence");
      release = rollbackRelease(release, sequence, values["published-at"]);
    }
    const dryRun = values["dry-run"] === true;
    const production = dryRun ? undefined : configuredR2Store();
    const result = await publishRelease(production?.store ?? new DirectoryStore(values["state-dir"] ?? ".modelspage/dry-run"), release, { allowFixture: dryRun, verifyPublic: production ? publicVerifier(production.publicBaseUrl) : undefined });
    console.log(stableStringify({ mode: dryRun ? "dry-run" : "production", ...result }).trim());
  } else {
    console.log("Modelspage: build | collect-rankings | collect | validate | coverage | fetch-current | publish | rollback. See README for explicit reproducible clocks, offline fixtures and dry-run examples.");
    if (command) process.exitCode = 1;
  }
}
if (import.meta.main) main().catch(error => {
  // SDK errors can carry signed request details: print a bounded message only.
  const message = error instanceof Error ? error.message : "Operation failed";
  console.error(message.slice(0, 1000));
  process.exitCode = 1;
});
