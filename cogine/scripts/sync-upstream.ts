import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function discoverDefaultBranch(output: string): string {
  const line = output.split("\n").find((entry) => /^ref: refs\/heads\/.+\tHEAD$/.test(entry));
  if (!line) throw new Error("Upstream did not advertise a symbolic default branch");
  const branch = line.slice("ref: refs/heads/".length, -"\tHEAD".length);
  if (!branch || branch.startsWith("-") || branch.includes("..")) throw new Error("Invalid upstream default branch");
  return branch;
}

export function isProtectedPath(file: string): boolean {
  return file === "README.md" || file === "AGENTS.md" || file.startsWith(".github/workflows/");
}

export function assertProtectedPathsUnchanged(changedPaths: string[]): void {
  const drift = changedPaths.filter(isProtectedPath);
  if (drift.length) throw new Error(`Protected paths differ from local version after merge: ${drift.join(", ")}`);
}

async function git(args: string[], allowFailure = false): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code !== 0 && !allowFailure) throw new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`);
  return { code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

async function archiveUpstream(ref: string): Promise<void> {
  for (const file of ["README.md", "AGENTS.md"]) {
    const result = await git(["show", `${ref}:${file}`], true);
    if (result.code === 0) await writeFile(`cogine/docs/upstream/${file}`, `${result.stdout}\n`);
  }
  const files = (await git(["ls-tree", "-r", "--name-only", ref, ".github/workflows/"])).stdout.split("\n").filter(Boolean);
  await rm("cogine/docs/upstream/workflows", { force: true, recursive: true });
  await mkdir("cogine/docs/upstream/workflows", { recursive: true });
  for (const file of files) {
    const content = await git(["show", `${ref}:${file}`]);
    const destination = path.join("cogine/docs/upstream/workflows", file.slice(".github/workflows/".length));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${content.stdout}\n`);
  }
}

export async function syncUpstream(merge = false): Promise<void> {
  const root = (await git(["rev-parse", "--show-toplevel"])).stdout;
  if (path.resolve(process.cwd()) !== path.resolve(root)) throw new Error("Run upstream sync from the Modelspage repository root");
  const origin = (await git(["remote", "get-url", "origin"])).stdout.replace(/\.git$/, "");
  if (!/^https:\/\/github\.com\/cogine-ai\/modelspage$/i.test(origin) && !/^git@github\.com:cogine-ai\/modelspage$/i.test(origin)) {
    throw new Error("Refusing to sync: origin is not cogine-ai/modelspage");
  }
  const configured = await git(["remote", "get-url", "upstream"], true);
  const upstreamURL = "https://github.com/anomalyco/models.dev.git";
  if (configured.code !== 0) await git(["remote", "add", "upstream", upstreamURL]);
  else if (configured.stdout.replace(/\.git$/, "") !== upstreamURL.replace(/\.git$/, "")) throw new Error("Unexpected upstream remote; review it manually");
  if (merge && (await git(["status", "--porcelain"])).stdout) throw new Error("Commit or preserve all existing changes before preparing an upstream merge");
  const advertised = await git(["ls-remote", "--symref", "upstream", "HEAD"]);
  const branch = discoverDefaultBranch(advertised.stdout);
  await git(["check-ref-format", "--branch", branch]);
  await git(["fetch", "--no-tags", "upstream", `+refs/heads/${branch}:refs/remotes/upstream/${branch}`]);
  const ref = `refs/remotes/upstream/${branch}`;
  const commit = (await git(["rev-parse", ref])).stdout;
  const alreadyMerged = (await git(["merge-base", "--is-ancestor", ref, "HEAD"], true)).code === 0;
  console.log(JSON.stringify({ mode: merge ? "merge" : "check", upstream_default_branch: branch, upstream_commit: commit, already_merged: alreadyMerged }));
  if (!merge || alreadyMerged) return;

  const ours = (await git(["rev-parse", "HEAD"])).stdout;
  const merged = await git(["merge", "--no-ff", "--no-commit", ref], true);
  if (merged.code !== 0 && merged.code !== 1) throw new Error(`Upstream merge failed: ${merged.stderr}`);
  // Our entry points and executable workflows stay under Modelspage review.
  // Upstream versions remain available as inert documentation, including newly added workflows.
  await archiveUpstream(ref);
  await git(["rm", "-r", "--ignore-unmatch", "--force", ".github/workflows"]);
  const ownFiles = (await git(["ls-tree", "-r", "--name-only", ours, ".github/workflows/"])).stdout;
  if (ownFiles) await git(["checkout", ours, "--", ".github/workflows"]);
  await git(["checkout", ours, "--", "README.md", "AGENTS.md"]);
  await git(["add", "README.md", "AGENTS.md", ".github/workflows", "cogine/docs/upstream"]);
  const stagedPaths = (await git(["diff", "--cached", "--name-only", "-z", ours, "--"])).stdout.split("\0").filter(Boolean);
  assertProtectedPathsUnchanged(stagedPaths);

  const unresolved = (await git(["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
  if (unresolved.length) {
    console.error(JSON.stringify({ status: "conflict", files: unresolved, instruction: "Resolve these files, validate, and commit the merge manually; no upstream deployment was enabled." }));
    throw new Error("Upstream merge requires review; merge state has been preserved");
  }
  const lock = JSON.parse(await readFile("cogine/upstream.lock.json", "utf8"));
  lock.commit = commit;
  lock.commit_time = (await git(["show", "-s", "--format=%cI", commit])).stdout;
  lock.default_branch_at_last_sync = branch;
  lock.synced_at = new Date().toISOString();
  const temporary = "cogine/upstream.lock.json.tmp";
  await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`);
  await rename(temporary, "cogine/upstream.lock.json");
  await git(["add", "cogine/upstream.lock.json"]);
  await git(["commit", "-m", `chore(upstream): merge ${branch} at ${commit.slice(0, 12)}`]);
  console.log("Prepared a local merge commit. Review, validate, and open a PR; main was not pushed.");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--merge" && arg !== "--check")) throw new Error("Usage: bun cogine/scripts/sync-upstream.ts [--check|--merge]");
  await syncUpstream(args.includes("--merge"));
}
