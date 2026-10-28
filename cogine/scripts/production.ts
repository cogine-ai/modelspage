import { appendFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fetchCurrentRelease } from "../src/active.js";
import { assertCorrectionContinuity } from "../src/corrections.js";
import { atomicWrite, stableStringify } from "../src/integrity.js";
import { assertPublishable, readRelease, verifyReleaseBytes, type Release } from "../src/publish.js";
import { assertInitialCpnReadiness } from "../src/readiness.js";
import { manifestSchema } from "../src/schema.js";
import type { Manifest } from "../src/types.js";

export function publicationPlan(previous: Manifest | null, commitTime: string) {
  manifestSchema.shape.published_at.parse(commitTime);
  if (previous?.fixture) throw new Error("An active fixture cannot seed production publication");
  const sequence = (previous?.publication_sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error("Publication sequence exhausted");
  // The trusted commit clock is fixed across retries; never move behind the current publication.
  const published_at = new Date(Math.max(Date.parse(commitTime), previous ? Date.parse(previous.published_at) : 0)).toISOString();
  return { sequence, published_at, has_previous: previous !== null };
}

export async function readActiveRelease(directory: string): Promise<Release | null> {
  const manifestPath = join(directory, "manifest.json");
  const catalogPath = join(directory, "catalog.json");
  const [manifestExists, catalogExists] = await Promise.all([Bun.file(manifestPath).exists(), Bun.file(catalogPath).exists()]);
  if (!manifestExists && !catalogExists) return null;
  if (!manifestExists || !catalogExists) throw new Error("Incomplete verified current release");
  const release = verifyReleaseBytes(JSON.parse(await readFile(manifestPath, "utf8")), await readFile(catalogPath, "utf8"));
  if (release.bundle.fixture) throw new Error("An active fixture cannot seed production publication");
  return release;
}

export function checkProductionCandidate(candidate: Release, previous: Release | null) {
  const checked = verifyReleaseBytes(candidate.manifest, candidate.catalogBody);
  assertPublishable(checked.bundle);
  if (!previous) return { initial_publication: true, ...assertInitialCpnReadiness(checked.bundle) };
  const active = verifyReleaseBytes(previous.manifest, previous.catalogBody);
  if (active.bundle.fixture) throw new Error("An active fixture cannot seed production publication");
  if (checked.manifest.publication_sequence <= active.manifest.publication_sequence) throw new Error("Production candidate must advance the current sequence");
  assertCorrectionContinuity(active.bundle.corrections, checked.bundle.corrections);
  return { initial_publication: false };
}

async function main() {
  const { positionals, values } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, strict: true, options: {
    "published-at": { type: "string" }, "active-dir": { type: "string" }, input: { type: "string" },
  } });
  const directory = resolve(values["active-dir"] ?? ".modelspage/active");
  if (positionals[0] === "prepare") {
    const baseUrl = process.env.MODELSPAGE_PUBLIC_BASE_URL;
    if (!baseUrl || !values["published-at"]) throw new Error("prepare requires MODELSPAGE_PUBLIC_BASE_URL and a fixed --published-at commit clock");
    const previous = await fetchCurrentRelease(baseUrl, fetch, { onEvent: public_read => console.error(JSON.stringify({ public_read })) });
    const plan = publicationPlan(previous?.manifest ?? null, values["published-at"]);
    if (previous) {
      await atomicWrite(join(directory, "catalog.json"), previous.catalog);
      await atomicWrite(join(directory, "manifest.json"), stableStringify(previous.manifest));
    } else {
      // A verified first-publication 404 must not reuse a local seed left by an earlier run.
      await Promise.all(["manifest.json", "catalog.json"].map(name => rm(join(directory, name), { force: true })));
    }
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `sequence=${plan.sequence}\npublished_at=${plan.published_at}\nhas_previous=${plan.has_previous}\n`);
    console.log(stableStringify(plan).trim());
  } else if (positionals[0] === "check") {
    const candidate = await readRelease(resolve(values.input ?? "dist/production"));
    console.log(stableStringify(checkProductionCandidate(candidate, await readActiveRelease(directory))).trim());
  } else throw new Error("Production preparation: prepare --published-at <trusted-commit-time> | check --input <release-directory>");
}
if (import.meta.main) main().catch(error => {
  console.error((error instanceof Error ? error.message : "Production preparation failed").slice(0, 1000));
  process.exitCode = 1;
});
