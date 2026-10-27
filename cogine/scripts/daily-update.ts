import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { atomicWrite, sha256, stableStringify } from "../src/integrity.js";
import { inspectRankingEnvelope } from "../src/ranking-input.js";
import { readRelease } from "../src/publish.js";

const trustedRoot = resolve(import.meta.dir, "../..");
export const RANKINGS_PATH = "cogine/data/rankings.json";
const executableInputs = ["packages/core", "package.json", "bun.lock", "bun.lockb", ".bun-version", "bunfig.toml", "tsconfig.json", "jsconfig.json", ".npmrc"];
type Validation = "pending" | "validated" | "manual_upstream_review_required" | "build_failed" | "unchanged";
export type DailyPlan = {
  schema_version: 1;
  base_commit: string;
  candidate_commit: string;
  upstream_commit: string;
  published_at: string;
  changed: boolean;
  branch: string;
  can_build: boolean;
  validation: Validation;
  whole_bundle_validated: boolean;
  manual_review_paths: string[];
  rankings_file_sha256: string;
  rankings_plaintext_sha256: string;
  evaluation_date: string;
  source_count: number;
  bundle_revision?: string;
};

export function dailyReviewBranch(base: string, candidate: string): string {
  if (![base, candidate].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error("Daily proposal requires exact Git commits");
  return `automation/daily-${candidate.slice(0, 12)}-${base.slice(0, 12)}`;
}

export function isDailyReviewBranch(branch: string): boolean {
  return /^automation\/(daily-|upstream-|data-openrouter-)/.test(branch);
}

export function codeReviewPaths(paths: string[]): string[] {
  return paths.filter(file => executableInputs.some(prefix => file === prefix || file.startsWith(prefix + "/"))
    || /^\.env(?:\.|$)/.test(file)
    || file.startsWith(".github/workflows/") || ["README.md", "AGENTS.md"].includes(file)
    || file.startsWith("cogine/") && file !== "cogine/upstream.lock.json" && file !== RANKINGS_PATH && !file.startsWith("cogine/docs/upstream/"));
}

export function encryptedProposal(bytes: string) {
  try { return inspectRankingEnvelope(JSON.parse(bytes)); }
  catch { throw new Error("Daily input must be a valid encrypted rankings envelope; no plaintext input may be proposed"); }
}

async function git(root: string, args: string[], allowFailure = false) {
  const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code && !allowFailure) throw new Error(`Daily git ${args[0]} failed (${code}); candidate was not published`);
  return { code, stdout: stdout.trimEnd(), stderr };
}

async function trustedSync(candidate: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("MODELSPAGE_") || ["GH_TOKEN", "GITHUB_TOKEN", "BUN_OPTIONS", "NODE_OPTIONS"].includes(key)) delete env[key];
  const configuration = join(trustedRoot, ".sync/daily-runtime/bunfig.toml");
  await atomicWrite(configuration, "# No candidate preloads or runtime configuration.\n");
  const child = Bun.spawn([process.execPath, "--no-env-file", `--config=${configuration}`, `--tsconfig-override=${join(trustedRoot, "cogine/tsconfig.json")}`, join(trustedRoot, "cogine/scripts/sync-upstream.ts"), "--merge"], { cwd: candidate, env, stdout: "pipe", stderr: "pipe" });
  // Imported source and parser output are never forwarded to a public workflow log.
  const [code] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()]);
  if (code) throw new Error("Upstream merge requires manual resolution; the previous reviewed inputs remain unchanged");
}

function outsideCandidate(candidate: string, packet: string) {
  const path = relative(candidate, packet);
  if (path !== ".." && !path.startsWith(".." + sep)) throw new Error("Daily artifacts must remain outside the candidate Git worktree");
}

export async function prepareDailyCandidate(options: { candidate: string; input: string; packetDir: string; publishedAt: string; expectedBase?: string; sync?: () => Promise<void> }): Promise<DailyPlan> {
  const candidate = resolve(options.candidate), packet = resolve(options.packetDir);
  outsideCandidate(candidate, packet);
  const clock = new Date(options.publishedAt);
  if (!Number.isFinite(clock.getTime())) throw new Error("Daily proposal requires one fixed ISO publication clock");
  const inputBytes = await readFile(options.input), envelope = encryptedProposal(inputBytes.toString("utf8"));
  const base = (await git(candidate, ["rev-parse", "HEAD"])).stdout;
  if (options.expectedBase && base !== options.expectedBase) throw new Error("Candidate does not start at the fixed trusted commit");
  if ((await git(candidate, ["status", "--porcelain"])).stdout) throw new Error("Daily preparation requires a clean candidate worktree");
  await (options.sync ?? (() => trustedSync(candidate)))();
  await atomicWrite(join(candidate, RANKINGS_PATH), inputBytes);
  await git(candidate, ["add", "--", RANKINGS_PATH]);
  if ((await git(candidate, ["diff", "--cached", "--quiet"], true)).code !== 0) await git(candidate, ["commit", "-m", "chore(data): update encrypted C/P input"]);
  const commit = (await git(candidate, ["rev-parse", "HEAD"])).stdout;
  const upstream = JSON.parse(await readFile(join(candidate, "cogine/upstream.lock.json"), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(upstream.commit)) throw new Error("Daily candidate has no exact upstream input commit");
  const changedPaths = (await git(candidate, ["diff", "--name-only", "-z", base, commit, "--"])).stdout.split("\0").filter(Boolean);
  const manual = codeReviewPaths(changedPaths);
  const changed = commit !== base;
  const plan: DailyPlan = {
    schema_version: 1, base_commit: base, candidate_commit: commit, upstream_commit: upstream.commit,
    published_at: clock.toISOString(), changed, branch: dailyReviewBranch(base, commit), can_build: changed && !manual.length,
    validation: !changed ? "unchanged" : manual.length ? "manual_upstream_review_required" : "pending", whole_bundle_validated: false,
    manual_review_paths: manual, rankings_file_sha256: sha256(inputBytes), rankings_plaintext_sha256: envelope.plaintext_sha256,
    evaluation_date: envelope.review.evaluation_date, source_count: envelope.review.sources.length,
  };
  await mkdir(packet, { recursive: true });
  await atomicWrite(join(packet, "plan.json"), stableStringify(plan));
  await atomicWrite(join(packet, "rankings.json"), inputBytes);
  return plan;
}

function readPlan(input: unknown): DailyPlan {
  const plan = input as DailyPlan;
  if (!plan || plan.schema_version !== 1 || plan.branch !== dailyReviewBranch(plan.base_commit, plan.candidate_commit)
    || !/^[a-f0-9]{40}$/.test(plan.upstream_commit) || !/^[a-f0-9]{64}$/.test(plan.rankings_file_sha256)
    || !/^[a-f0-9]{64}$/.test(plan.rankings_plaintext_sha256) || !Array.isArray(plan.manual_review_paths)
    || typeof plan.changed !== "boolean" || typeof plan.can_build !== "boolean") throw new Error("Invalid daily candidate plan");
  return plan;
}

export async function packageDailyCandidate(options: { candidate: string; packetDir: string; buildOutcome: string; buildDir?: string; collectionReport?: string }): Promise<DailyPlan> {
  const candidate = resolve(options.candidate), packet = resolve(options.packetDir);
  outsideCandidate(candidate, packet);
  const plan = readPlan(JSON.parse(await readFile(join(packet, "plan.json"), "utf8")));
  if ((await git(candidate, ["rev-parse", "HEAD"])).stdout !== plan.candidate_commit || (await git(candidate, ["status", "--porcelain"])).stdout) throw new Error("Candidate changed after its inputs were fixed");
  const inputBytes = await readFile(join(candidate, RANKINGS_PATH));
  const envelope = encryptedProposal(inputBytes.toString("utf8"));
  if (sha256(inputBytes) !== plan.rankings_file_sha256 || envelope.plaintext_sha256 !== plan.rankings_plaintext_sha256) throw new Error("Daily ranking input changed after preparation");
  if (plan.can_build && options.buildOutcome === "success") {
    if (!options.buildDir) throw new Error("A validated daily candidate requires its build directory");
    let release;
    try { release = await readRelease(options.buildDir); }
    catch { throw new Error("Daily catalog schema, revision or object integrity validation failed"); }
    if (release.bundle.source_revisions.find(source => source.id === "models-dev")?.code_commit !== plan.upstream_commit) throw new Error("Daily release does not use the fixed models.dev input");
    if (release.bundle.published_at !== plan.published_at || release.manifest.published_at !== plan.published_at || release.bundle.publication_sequence !== 1 || release.manifest.publication_sequence !== 1) throw new Error("Daily release does not use the fixed review clock and sequence");
    const report = JSON.parse(await readFile(join(options.buildDir, "reports/rankings.json"), "utf8"));
    if (report.input_sha256 !== plan.rankings_plaintext_sha256 || report.evaluation_date !== plan.evaluation_date) throw new Error("Daily ranking report does not match the fixed encrypted input");
    plan.validation = "validated"; plan.whole_bundle_validated = true; plan.bundle_revision = release.manifest.revision;
  } else if (plan.can_build) plan.validation = "build_failed";
  else if (plan.changed) plan.validation = "manual_upstream_review_required";
  const safeAttempts: Record<string, unknown>[] = [];
  if (options.collectionReport) {
    const report = JSON.parse(await readFile(options.collectionReport, "utf8"));
    for (const attempt of Array.isArray(report.attempts) ? report.attempts : []) {
      safeAttempts.push(Object.fromEntries(["source_id", "kind", "status", "changed", "complete_response", "retained_last_good", "entry_count", "attempted_at", "retrieved_at", "data_as_of"].flatMap(key => ["string", "number", "boolean"].includes(typeof attempt[key]) || attempt[key] === null ? [[key, attempt[key]]] : [])));
    }
  }
  await atomicWrite(join(packet, "plan.json"), stableStringify(plan));
  await atomicWrite(join(packet, "review.json"), stableStringify({ plan, review: envelope.review, collection_attempts: safeAttempts, secrets_or_plaintext_included: false }));
  if (plan.changed) {
    await git(candidate, ["bundle", "create", join(packet, "proposal.bundle"), "HEAD", `^${plan.base_commit}`]);
    if ((await stat(join(packet, "proposal.bundle"))).size === 0) throw new Error("Daily proposal bundle is empty");
  }
  return plan;
}

async function output(plan: DailyPlan) {
  const values = { changed: String(plan.changed), can_build: String(plan.can_build), branch: plan.branch, base_commit: plan.base_commit, candidate_commit: plan.candidate_commit, published_at: plan.published_at, validation: plan.validation };
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
  console.log(stableStringify({ ...values, whole_bundle_validated: plan.whole_bundle_validated }).trim());
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: {
    candidate: { type: "string" }, input: { type: "string" }, "packet-dir": { type: "string" }, "published-at": { type: "string" }, "base-commit": { type: "string" }, "build-outcome": { type: "string" }, "build-dir": { type: "string" }, "collection-report": { type: "string" },
  } });
  try {
    if (!values.candidate || !values["packet-dir"]) throw new Error("Daily command requires candidate and packet-dir");
    if (positionals[0] === "prepare" && values.input && values["published-at"]) await output(await prepareDailyCandidate({ candidate: values.candidate, input: values.input, packetDir: values["packet-dir"], publishedAt: values["published-at"], expectedBase: values["base-commit"] }));
    else if (positionals[0] === "package" && values["build-outcome"]) await output(await packageDailyCandidate({ candidate: values.candidate, packetDir: values["packet-dir"], buildOutcome: values["build-outcome"], buildDir: values["build-dir"], collectionReport: values["collection-report"] }));
    else throw new Error("Usage: daily-update.ts prepare|package with explicit fixed inputs");
  } catch (error) { console.error(error instanceof Error ? error.message : "Daily candidate preparation failed"); process.exitCode = 1; }
}
