import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeReviewPaths, dailyReviewBranch, encryptedProposal, isDailyReviewBranch, packageDailyCandidate, prepareDailyCandidate } from "../scripts/daily-update.js";
import { RANKING_INPUT_FORMAT } from "../src/ranking-input.js";
import { seal } from "./contract-fixture.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const envelope = { format: RANKING_INPUT_FORMAT, plaintext_sha256: "a".repeat(64), nonce: Buffer.alloc(12).toString("base64"), tag: Buffer.alloc(16).toString("base64"), ciphertext: Buffer.from("synthetic encrypted bytes").toString("base64"), review: { evaluation_date: "2026-10-27", policy_id: "fixture", sources: [] } };
const clock = "2026-10-27T02:17:00.000Z";
async function fixture(seed = false) {
  const directory = await mkdtemp(join(tmpdir(), "modelspage-daily-")); temporary.push(directory);
  const candidate = join(directory, "candidate"), packetDir = join(directory, "packet"), input = join(directory, "rankings.json"), buildDir = join(directory, "private-build");
  await mkdir(join(candidate, "cogine/data"), { recursive: true });
  await mkdir(join(candidate, "packages/core"), { recursive: true });
  await writeFile(join(candidate, "package.json"), "{}\n");
  await writeFile(join(candidate, "bun.lock"), "fixture\n");
  await writeFile(join(candidate, "cogine/upstream.lock.json"), JSON.stringify({ commit: "b".repeat(40) }));
  if (seed) await writeFile(join(candidate, "cogine/data/rankings.json"), JSON.stringify(envelope));
  await writeFile(input, JSON.stringify(envelope));
  function git(...args: string[]) {
    const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd: candidate });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  }
  git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false");
  git("add", "."); git("commit", "--quiet", "-m", "fixture baseline");
  const base = git("rev-parse", "HEAD");
  return { candidate, packetDir, input, buildDir, base, git };
}

async function completeRelease(buildDir: string, upstreamCommit = "b".repeat(40), publishedAt = clock) {
  const input = await Bun.file("cogine/fixtures/contracts/valid-catalog-v2.json").json();
  input.published_at = publishedAt;
  input.source_revisions.push({ id: "models-dev", code_commit: upstreamCommit, status: "success", retrieved_at: clock, data_as_of: null, window: { start: null, end: null }, usage: { collection: "allowed", redistribution: "allowed", evidence: "Synthetic test input" }, complete: true });
  const release = seal(input);
  const catalogPath = join(buildDir, release.manifest.objects.catalog.path);
  await mkdir(join(catalogPath, ".."), { recursive: true });
  await mkdir(join(buildDir, "reports"), { recursive: true });
  await writeFile(catalogPath, release.catalog);
  await writeFile(join(buildDir, "v1/manifest.json"), JSON.stringify(release.manifest));
  await writeFile(join(buildDir, "reports/rankings.json"), JSON.stringify({ input_sha256: envelope.plaintext_sha256, evaluation_date: envelope.review.evaluation_date }));
  return { ...release, catalogPath };
}

describe("daily fixed-input proposal", () => {
  test("uses exact commits and recognizes only same-purpose automation branch families", () => {
    expect(dailyReviewBranch("a".repeat(40), "b".repeat(40))).toBe("automation/daily-bbbbbbbbbbbb-aaaaaaaaaaaa");
    expect(() => dailyReviewBranch("main", "b".repeat(40))).toThrow("exact Git");
    for (const branch of ["automation/daily-one", "automation/upstream-one", "automation/data-openrouter-one"]) expect(isDailyReviewBranch(branch)).toBe(true);
    expect(isDailyReviewBranch("cliq/production-readiness")).toBe(false);
  });
  test("public proposal validation refuses plaintext or additional raw source fields without a key", () => {
    expect(encryptedProposal(JSON.stringify(envelope)).plaintext_sha256).toBe(envelope.plaintext_sha256);
    expect(() => encryptedProposal(JSON.stringify({ snapshots: [{ entries: [{ score: 88 }] }] }))).toThrow("no plaintext");
    expect(() => encryptedProposal(JSON.stringify({ ...envelope, raw: "private source body" }))).toThrow("no plaintext");
  });
  test("executable drift requires review while models/N and ciphertext remain data inputs", () => {
    expect(codeReviewPaths(["models/lab/model.toml", "providers/lab/models/model.toml", "cogine/upstream.lock.json", "cogine/data/rankings.json", "cogine/docs/upstream/workflows/deploy.yml"])).toEqual([]);
    expect(codeReviewPaths(["packages/core/src/schema.ts", "package.json", "bun.lock", ".bun-version", "cogine/src/build.ts"])).toHaveLength(5);
    expect(codeReviewPaths(["bunfig.toml", "tsconfig.json", "jsconfig.json", ".env", ".env.production", ".npmrc"])).toHaveLength(6);
  });
  test("a fixed clean candidate commits only ciphertext then packages the exact validated tree", async () => {
    const f = await fixture();
    const plan = await prepareDailyCandidate({ ...f, publishedAt: clock, expectedBase: f.base, sync: async () => {} });
    expect(plan).toMatchObject({ changed: true, can_build: true, validation: "pending", whole_bundle_validated: false, published_at: clock });
    expect(f.git("diff", "--name-only", f.base, "HEAD")).toBe("cogine/data/rankings.json");
    const release = await completeRelease(f.buildDir);
    const final = await packageDailyCandidate({ ...f, buildOutcome: "success" });
    expect(final).toMatchObject({ validation: "validated", whole_bundle_validated: true, bundle_revision: release.manifest.revision });
    expect(await Bun.file(join(f.packetDir, "proposal.bundle")).exists()).toBe(true);
    expect(await readFile(join(f.packetDir, "rankings.json"), "utf8")).toBe(JSON.stringify(envelope));
    expect(f.git("status", "--porcelain")).toBe("");
  });
  test("a parser update keeps a reviewable proposal but never claims whole-bundle validation", async () => {
    const f = await fixture();
    const plan = await prepareDailyCandidate({ ...f, publishedAt: clock, sync: async () => {
      await writeFile(join(f.candidate, "packages/core/new-parser.ts"), "unreviewed parser\n");
      f.git("add", "packages/core"); f.git("commit", "--quiet", "-m", "fixture upstream parser update");
    } });
    expect(plan).toMatchObject({ changed: true, can_build: false, validation: "manual_upstream_review_required" });
    const final = await packageDailyCandidate({ ...f, buildOutcome: "skipped" });
    expect(final.whole_bundle_validated).toBe(false);
    expect(final.validation).toBe("manual_upstream_review_required");
    expect(await Bun.file(join(f.packetDir, "proposal.bundle")).exists()).toBe(true);
  });
  test("unchanged inputs produce no candidate and failed builds are reported honestly", async () => {
    const f = await fixture(true);
    const plan = await prepareDailyCandidate({ ...f, publishedAt: clock, sync: async () => {} });
    expect(plan).toMatchObject({ changed: false, can_build: false, validation: "unchanged" });
    expect((await packageDailyCandidate({ ...f, buildOutcome: "skipped" })).whole_bundle_validated).toBe(false);
    expect(await Bun.file(join(f.packetDir, "proposal.bundle")).exists()).toBe(false);
    const changed = await fixture();
    await prepareDailyCandidate({ ...changed, publishedAt: clock, sync: async () => {} });
    expect(await packageDailyCandidate({ ...changed, buildOutcome: "failure" })).toMatchObject({ validation: "build_failed", whole_bundle_validated: false });
  });
  test("candidate or ranking input changes after preparation cannot enter a proposal", async () => {
    const f = await fixture();
    await prepareDailyCandidate({ ...f, publishedAt: clock, sync: async () => {} });
    await writeFile(join(f.candidate, "cogine/data/rankings.json"), "tampered plaintext\n");
    await expect(packageDailyCandidate({ ...f, buildOutcome: "success" })).rejects.toThrow("Candidate changed");
  });
  test("a manifest-shaped value or tampered catalog cannot claim whole-bundle PASS", async () => {
    const f = await fixture();
    await prepareDailyCandidate({ ...f, publishedAt: clock, sync: async () => {} });
    await mkdir(join(f.buildDir, "v1"), { recursive: true });
    await writeFile(join(f.buildDir, "v1/manifest.json"), JSON.stringify({ revision: "c".repeat(64) }));
    await expect(packageDailyCandidate({ ...f, buildOutcome: "success" })).rejects.toThrow("integrity validation");
    const release = await completeRelease(f.buildDir);
    await writeFile(release.catalogPath, release.catalog + " ");
    await expect(packageDailyCandidate({ ...f, buildOutcome: "success" })).rejects.toThrow("integrity validation");
  });
  test("valid release bytes from another source commit or input report are rejected", async () => {
    const f = await fixture();
    await prepareDailyCandidate({ ...f, publishedAt: clock, sync: async () => {} });
    await completeRelease(f.buildDir, "d".repeat(40));
    await expect(packageDailyCandidate({ ...f, buildOutcome: "success" })).rejects.toThrow("fixed models.dev input");
    await completeRelease(f.buildDir);
    await writeFile(join(f.buildDir, "reports/rankings.json"), JSON.stringify({ input_sha256: "d".repeat(64), evaluation_date: envelope.review.evaluation_date }));
    await expect(packageDailyCandidate({ ...f, buildOutcome: "success" })).rejects.toThrow("fixed encrypted input");
  });
  test("a valid release cannot silently use a later review clock", async () => {
    const f = await fixture();
    await prepareDailyCandidate({ ...f, publishedAt: clock, sync: async () => {} });
    await completeRelease(f.buildDir, "b".repeat(40), "2026-10-28T00:00:00.000Z");
    await expect(packageDailyCandidate({ ...f, buildOutcome: "success" })).rejects.toThrow("fixed review clock");
  });
  test("artifacts cannot live inside the candidate and safe reviews omit private diagnostic bodies", async () => {
    const f = await fixture();
    await expect(prepareDailyCandidate({ ...f, packetDir: join(f.candidate, "..packet"), publishedAt: clock, sync: async () => {} })).rejects.toThrow("outside");
    await prepareDailyCandidate({ ...f, publishedAt: clock, sync: async () => {} });
    const report = join(f.packetDir, "private-collection-fixture.json");
    await writeFile(report, JSON.stringify({ attempts: [{ source_id: "fixture", status: "failed", entry_count: 0, error: "sensitive raw response", raw_files: ["private file"] }], snapshots: [{ score: 999 }] }));
    await packageDailyCandidate({ ...f, buildOutcome: "failure", collectionReport: report });
    const safe = await readFile(join(f.packetDir, "review.json"), "utf8");
    expect(safe).toContain("failed");
    expect(safe).not.toContain("sensitive");
    expect(safe).not.toContain("raw_files");
    expect(safe).not.toContain('"score":999');
    expect(JSON.parse(safe)).not.toHaveProperty("snapshots");
  });

  test("a candidate Bun preload never executes in a keyed trusted-cwd build or isolated sync runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "modelspage-runtime-")); temporary.push(directory);
    const trusted = join(directory, "trusted"), candidate = join(directory, "candidate"), marker = join(directory, "candidate-preload-ran");
    await mkdir(trusted); await mkdir(candidate);
    await writeFile(join(trusted, "main.ts"), 'if (process.env.MODELSPAGE_CANDIDATE_ENV) throw new Error("Candidate env loaded"); console.log("TRUSTED_MAIN");');
    await writeFile(join(trusted, "bunfig.toml"), "# Trusted empty config\n");
    await writeFile(join(trusted, "tsconfig.json"), "{}\n");
    await writeFile(join(candidate, "preload.ts"), `await Bun.write(${JSON.stringify(marker)}, "unreviewed execution"); console.log("CANDIDATE_PRELOAD");`);
    await writeFile(join(candidate, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await writeFile(join(candidate, ".env"), "MODELSPAGE_CANDIDATE_ENV=should-not-load\n");
    const env = { ...Bun.env, MODELSPAGE_INPUT_ENCRYPTION_KEY: "synthetic-runtime-key" };
    const build = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(trusted,"bunfig.toml")}`, join(trusted,"main.ts"), "--root", candidate], { cwd: trusted, env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(build.stdout).text();
    expect(await build.exited).toBe(0);
    expect(output.trim()).toBe("TRUSTED_MAIN");
    const sync = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(trusted,"bunfig.toml")}`, `--tsconfig-override=${join(trusted,"tsconfig.json")}`, join(trusted,"main.ts")], { cwd: candidate, env: { ...env, MODELSPAGE_INPUT_ENCRYPTION_KEY: undefined }, stdout: "pipe", stderr: "pipe" });
    expect((await new Response(sync.stdout).text()).trim()).toBe("TRUSTED_MAIN");
    expect(await sync.exited).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
