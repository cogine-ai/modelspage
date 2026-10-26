import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("upstream proposal defaults to read-only and never invokes Bun on merged configuration", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/modelspage-upstream.yml").text()) as any;
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.propose.permissions).toEqual({ contents: "write", "pull-requests": "write", actions: "write" });
  const prepare = workflow.jobs.propose.steps.find((step: any) => step.id === "sync").run as string;
  const afterMerge = prepare.split("bun cogine/scripts/sync-upstream.ts --merge")[1];
  expect(afterMerge).toBeDefined();
  expect(afterMerge).not.toMatch(/\bbun\b/);
  expect(afterMerge).toContain("jq -er");
  const push = workflow.jobs.propose.steps.find((step: any) => step.name === "Push exact merge and open review PR").run as string;
  expect(push).not.toMatch(/\bbun\b/);
  expect(push).toContain("gh workflow run modelspage-ci.yml");
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
  expect(publish.steps.slice(0, writeIndex).every((step: any) => !JSON.stringify(step).includes("secrets."))).toBe(true);
  expect(publish.steps[writeIndex].run).toBe("bun cogine/src/cli.ts publish --input dist/production");
});
