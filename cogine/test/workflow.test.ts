import { expect, test } from "bun:test";

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
