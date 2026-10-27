import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("legacy upstream entry only dispatches the single serialized daily review", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/modelspage-upstream.yml").text()) as any;
  const daily = Bun.YAML.parse(await Bun.file(".github/workflows/modelspage-collect.yml").text()) as any;
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.on.schedule).toBeUndefined();
  expect(workflow.jobs.request.permissions).toEqual({ contents: "read", actions: "write" });
  expect(workflow.jobs.request.if).toContain("github.event.repository.default_branch");
  expect(workflow.concurrency).toEqual(daily.concurrency);
  expect(workflow.jobs.request.steps[0].run).toContain("gh workflow run modelspage-collect.yml");
  expect(JSON.stringify(workflow)).not.toContain("secrets.");
  expect(JSON.stringify(workflow)).not.toContain("sync-upstream.ts");
});

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("production accepts only the exact current merged PR commit or a manual main retry", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/modelspage-publish.yml").text()) as any;
  const script = workflow.jobs.reviewed.steps.find((step: any) => step.id === "review").run as string;
  const directory = await mkdtemp(join(tmpdir(), "modelspage-workflow-")); directories.push(directory);
  const pullsPath = join(directory, "pulls.json");
  const outputPath = join(directory, "output");
  await writeFile(join(directory, "gh"), `#!/bin/sh
case "$*" in
  *git/ref/heads/main*) printf '%s\\n' "$TEST_MAIN_SHA" ;;
  *commits/*/pulls*) if [ "$TEST_PULLS_ERROR" = 'true' ]; then echo 'temporary API failure' >&2; exit 1; fi; cat "$TEST_PULLS_FILE" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  const sha = "a".repeat(40);
  const merged = { merged_at: "2026-10-26T00:00:00Z", merge_commit_sha: sha, base: { ref: "main", repo: { full_name: "cogine-ai/modelspage" } } };
  async function accepts(pulls: unknown[], event = "push", current = sha, apiError = false) {
    await writeFile(pullsPath, JSON.stringify([pulls]));
    await writeFile(outputPath, "");
    const process = Bun.spawn(["bash", "-e", "-c", script], { env: { ...Bun.env, PATH: `${directory}:${Bun.env.PATH}`, GITHUB_REPOSITORY: "cogine-ai/modelspage", GITHUB_OUTPUT: outputPath, COMMIT_SHA: sha, EVENT_NAME: event, TEST_MAIN_SHA: current, TEST_PULLS_FILE: pullsPath, TEST_PULLS_ERROR: String(apiError) }, stdout: "pipe", stderr: "pipe" });
    const code = await process.exited;
    expect(code).toBe(apiError ? 1 : 0);
    return await Bun.file(outputPath).text();
  }
  expect(await accepts([merged])).toBe("publish=true\n");
  expect(await accepts([{ ...merged, merged_at: null }])).toBe("publish=false\n");
  expect(await accepts([{ ...merged, merge_commit_sha: "b".repeat(40) }])).toBe("publish=false\n");
  expect(await accepts([{ ...merged, base: { ...merged.base, ref: "dev" } }])).toBe("publish=false\n");
  expect(await accepts([{ ...merged, base: { ...merged.base, repo: { full_name: "other/modelspage" } } }])).toBe("publish=false\n");
  expect(await accepts([merged], "push", "c".repeat(40))).toBe("publish=false\n");
  expect(await accepts([], "workflow_dispatch")).toBe("publish=true\n");
  expect(await accepts([], "workflow_dispatch", "c".repeat(40))).toBe("publish=false\n");
  expect(await accepts([merged], "push", sha, true)).toBe("");
});

test("production secrets follow reviewed-main, fixed planning, validation and the initial CPN gate", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/modelspage-publish.yml").text()) as any;
  expect(workflow.on.push.branches).toEqual(["main"]);
  expect(workflow.on.workflow_dispatch).toBeNull();
  expect(workflow.on.pull_request).toBeUndefined();
  expect(workflow.on.pull_request_target).toBeUndefined();
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.reviewed.environment).toBeUndefined();
  expect(workflow.jobs.reviewed.if).toContain("github.ref == 'refs/heads/main'");
  const publish = workflow.jobs.publish;
  expect(publish.needs).toBe("reviewed");
  expect(publish.if).toBe("needs.reviewed.outputs.publish == 'true'");
  expect(publish.environment).toBe("production");
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  expect(publish.steps.find((step: any) => step.uses?.startsWith("actions/checkout@")).with).toMatchObject({ ref: "${{ github.sha }}", "persist-credentials": false });
  const prepare = publish.steps.find((step: any) => step.id === "plan");
  expect(prepare.run).toContain("git show -s --format=%cI HEAD");
  expect(prepare.run).toContain("production.ts prepare");
  const checkIndex = publish.steps.findIndex((step: any) => step.run?.includes("production.ts check"));
  const writeIndex = publish.steps.findIndex((step: any) => step.env?.MODELSPAGE_R2_SECRET_ACCESS_KEY);
  expect(checkIndex).toBeGreaterThan(0);
  expect(writeIndex).toBeGreaterThan(checkIndex);
  expect(publish.steps[writeIndex - 1].run).toContain('test "$current" = "$COMMIT_SHA"');
  const buildIndex = publish.steps.findIndex((step: any) => step.name === "Build pinned reviewed inputs");
  expect(publish.steps[buildIndex].env.MODELSPAGE_INPUT_ENCRYPTION_KEY).toBe("${{ secrets.MODELSPAGE_INPUT_ENCRYPTION_KEY }}");
  for (const [index, step] of publish.steps.entries()) {
    if (index < writeIndex) expect(JSON.stringify(step)).not.toMatch(/secrets\.(?:MODELSPAGE_R2_|MODELSPAGE_AA_API_KEY|MODELSPAGE_OPENROUTER_API_KEY)/);
    if (JSON.stringify(step).includes("secrets.MODELSPAGE_INPUT_ENCRYPTION_KEY")) expect(index).toBe(buildIndex);
  }
  const ci = await Bun.file(".github/workflows/modelspage-ci.yml").text();
  expect(ci).not.toContain("secrets.MODELSPAGE_INPUT_ENCRYPTION_KEY");
  const daily = Bun.YAML.parse(await Bun.file(".github/workflows/modelspage-collect.yml").text()) as any;
  expect(JSON.stringify(daily.jobs.propose)).not.toContain("MODELSPAGE_INPUT_ENCRYPTION_KEY");
  expect(publish.steps[writeIndex].run).toBe("bun cogine/src/cli.ts publish --input dist/production");
});

test("daily collection fixes one trusted input cohort and isolates all write permissions", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/modelspage-collect.yml").text()) as any;
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.on.schedule).toHaveLength(1);
  expect(workflow.on.pull_request).toBeUndefined();
  expect(workflow.on.pull_request_target).toBeUndefined();
  expect(workflow.jobs.collect.if).toContain("github.event.repository.default_branch");
  expect(workflow.jobs.prepare.permissions).toEqual({ contents: "read", actions: "read" });
  const collector = workflow.jobs.collect.steps.find((step: any) => step.run?.includes("collect-rankings"));
  expect(collector.run).toContain('$GITHUB_WORKSPACE/trusted/cogine/src/cli.ts');
  expect(collector.env.MODELSPAGE_AA_API_KEY).toBe("${{ secrets.MODELSPAGE_AA_API_KEY }}");
  expect(collector.env.MODELSPAGE_INPUT_ENCRYPTION_KEY).toBe("${{ secrets.MODELSPAGE_INPUT_ENCRYPTION_KEY }}");
  const checkouts = workflow.jobs.prepare.steps.filter((step: any) => step.uses?.startsWith("actions/checkout@"));
  expect(checkouts.map((step: any) => step.with.path)).toEqual(["trusted", "candidate"]);
  expect(checkouts.every((step: any) => step.with.ref === "${{ github.sha }}" && step.with["persist-credentials"] === false)).toBe(true);
  const build = workflow.jobs.prepare.steps.find((step: any) => step.id === "build");
  expect(build.if).toBe("steps.candidate.outputs.can_build == 'true'");
  expect(build["working-directory"]).toBe("trusted");
  expect(build.run).toContain('$GITHUB_WORKSPACE/trusted/cogine/src/cli.ts');
  expect(build.run).toContain('build --root "$GITHUB_WORKSPACE/candidate"');
  expect(build.run).toContain('--no-env-file --config="$GITHUB_WORKSPACE/trusted/.sync/daily-runtime/bunfig.toml"');
  expect(build.run).toContain('--rankings-input "$GITHUB_WORKSPACE/candidate/cogine/data/rankings.json"');
  expect(build.env.MODELSPAGE_INPUT_ENCRYPTION_KEY).toBe("${{ secrets.MODELSPAGE_INPUT_ENCRYPTION_KEY }}");
  const propose = workflow.jobs.propose;
  expect(propose.permissions).toEqual({ contents: "write", "pull-requests": "write", actions: "write" });
  expect(JSON.stringify(propose)).not.toContain("secrets.");
  expect(JSON.stringify(propose)).not.toContain("MODELSPAGE_INPUT_ENCRYPTION_KEY");
  expect(propose.steps.some((step: any) => /\bbun\b/.test(step.run ?? "") || step.uses?.startsWith("oven-sh/"))).toBe(false);
  expect(JSON.stringify(workflow)).not.toContain("MODELSPAGE_PUBLISH_ENABLED");
  expect(JSON.stringify(workflow)).not.toContain("MODELSPAGE_R2_");
});

test("daily public artifacts contain only ciphertext, Git bundle and safe metadata", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/modelspage-collect.yml").text()) as any;
  const uploads = Object.values(workflow.jobs).flatMap((job: any) => job.steps.filter((step: any) => step.uses?.startsWith("actions/upload-artifact@"))) as any[];
  expect(uploads.map(step => step.with.path.trim().split("\n"))).toEqual([
    ["trusted/.sync/proposal/rankings.json", "trusted/.sync/proposal/collection.json"],
    [".sync/packet/proposal.bundle", ".sync/packet/rankings.json", ".sync/packet/plan.json", ".sync/packet/review.json"],
  ]);
  expect(uploads.every(step => !/raw|private-build|catalog\.json|\*/.test(step.with.path))).toBe(true);
  for (const job of Object.values(workflow.jobs) as any[]) for (const step of job.steps) if (step.run) {
    const child = Bun.spawn(["bash", "-n"], { stdin: new Blob([step.run]), stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  }
});

test("daily write job skips stale bases and existing automation PRs before any push", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/modelspage-collect.yml").text()) as any;
  const script = workflow.jobs.propose.steps.find((step: any) => step.run)?.run as string;
  const directory = await mkdtemp(join(tmpdir(), "modelspage-daily-guard-")); directories.push(directory);
  const proposal = join(directory, ".sync/proposal");
  await mkdir(proposal, { recursive: true });
  const base = "a".repeat(40);
  await writeFile(join(proposal, "plan.json"), JSON.stringify({ base_commit: base, candidate_commit: "b".repeat(40), branch: "automation/daily-bbbbbbbbbbbb-aaaaaaaaaaaa", validation: "validated", rankings_file_sha256: "c".repeat(64) }));
  await writeFile(join(directory, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_CALLS"
case "$*" in
  *git/ref/heads/*) printf '%s\\n' "$TEST_MAIN" ;;
  *pulls*) if [ "$TEST_API_ERROR" = true ]; then exit 1; fi; printf '%s\\n' "$TEST_PULLS" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  async function run(current: string, pulls: unknown[], apiError = false) {
    const summary = join(directory, "summary"), calls = join(directory, "calls");
    await writeFile(summary, ""); await writeFile(calls, "");
    const child = Bun.spawn(["bash", "-e", "-c", script], { cwd: directory, env: { ...Bun.env, PATH: `${directory}:${Bun.env.PATH}`, BASE_COMMIT: base, DEFAULT_BRANCH: "trunk", GITHUB_REPOSITORY: "cogine-ai/modelspage", GITHUB_STEP_SUMMARY: summary, TEST_MAIN: current, TEST_PULLS: JSON.stringify([pulls]), TEST_CALLS: calls, TEST_API_ERROR: String(apiError) }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(apiError ? 1 : 0);
    expect(await Bun.file(calls).text()).not.toContain("pr create");
    return await Bun.file(summary).text();
  }
  expect(await run("d".repeat(40), [])).toContain("default branch advanced");
  const pr = { head: { repo: { full_name: "cogine-ai/modelspage" }, ref: "automation/daily-existing" } };
  expect(await run(base, [pr])).toContain("review PR is still open");
  expect(await run(base, [{ head: { ...pr.head, ref: "automation/upstream-existing" } }])).toContain("review PR is still open");
  expect(await run(base, [], true)).toBe("");
  expect(script).not.toContain("--force");
  expect(script).toContain("git diff --quiet");
  expect(script).toContain("gh workflow run modelspage-ci.yml");
});
