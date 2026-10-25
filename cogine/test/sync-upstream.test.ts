import { describe, expect, test } from "bun:test";
import { discoverDefaultBranch, isProtectedPath } from "../scripts/sync-upstream";

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
});
