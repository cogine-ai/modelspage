import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertProtectedPathsUnchanged, discoverDefaultBranch, isProtectedPath } from "../scripts/sync-upstream";

describe("upstream sync safety", () => {
  test("discovers a renamed default branch without assuming dev or main", () => {
    expect(discoverDefaultBranch("ref: refs/heads/releases/current\tHEAD\nabc\tHEAD\n")).toBe("releases/current");
    expect(discoverDefaultBranch("ref: refs/heads/trunk\tHEAD\nabc\tHEAD")).toBe("trunk");
  });
  test("fails closed when symbolic branch is absent or unsafe", () => {
    expect(() => discoverDefaultBranch("abc\tHEAD")).toThrow();
    expect(() => discoverDefaultBranch("ref: refs/heads/--upload-pack=bad\tHEAD")).toThrow();
    expect(() => discoverDefaultBranch("ref: refs/heads/../bad\tHEAD")).toThrow();
  });
  test("keeps new upstream workflows and project entry points under local review", () => {
    expect(isProtectedPath(".github/workflows/new-deploy.yml")).toBe(true);
    expect(isProtectedPath("README.md")).toBe(true);
    expect(isProtectedPath("AGENTS.md")).toBe(true);
    expect(isProtectedPath("providers/openrouter/models/test.toml")).toBe(false);
  });
  test("staged merge guard rejects protected drift and permits catalog changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "modelspage-upstream-guard-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd: directory });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      return new TextDecoder().decode(result.stdout);
    };
    try {
      git("init", "--quiet");
      git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
      await writeFile(path.join(directory, "README.md"), "Local entry point\n");
      git("add", "README.md"); git("commit", "--quiet", "-m", "fixture baseline");
      const ours = git("rev-parse", "HEAD").trim();
      await mkdir(path.join(directory, ".github/workflows"), { recursive: true });
      await writeFile(path.join(directory, ".github/workflows/unreviewed\njob.yml"), "name: imported\n");
      git("add", ".github/workflows");
      const staged = git("diff", "--cached", "--name-only", "-z", ours, "--").split("\0").filter(Boolean);
      expect(() => assertProtectedPathsUnchanged(staged)).toThrow("Protected paths");
      git("reset", "--hard", "--quiet", ours);
      await mkdir(path.join(directory, "providers"), { recursive: true });
      await writeFile(path.join(directory, "providers/model.toml"), "schema = 2\n");
      git("add", "providers");
      const catalogOnly = git("diff", "--cached", "--name-only", "-z", ours, "--").split("\0").filter(Boolean);
      expect(() => assertProtectedPathsUnchanged(catalogOnly)).not.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
