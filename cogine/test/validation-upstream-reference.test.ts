import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCompatibleModels, projectFixedParserDates, referenceReleaseDate } from "../scripts/validation/upstream-reference.js";
import { AuthoredModelV2 } from "../../packages/core/src/schema-v2.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "modelspage-compatible-reference-"));
  const dataDir = join(root, "data");
  await mkdir(join(dataDir, "models/fixture"), { recursive: true });
  await mkdir(join(dataDir, "providers/fixture/models"), { recursive: true });
  const goodLab = await Bun.file("models/openai/gpt-4o.toml").text();
  await Bun.write(join(dataDir, "models/fixture/good.toml"), goodLab);
  await Bun.write(join(dataDir, "providers/fixture/provider.toml"), 'name = "Fixture"\nenv = ["FIXTURE_UNUSED"]\nnpm = "@ai-sdk/openai"\ndoc = "https://example.com/models"\n');
  await Bun.write(join(dataDir, "providers/fixture/models/good.toml"), 'base_model = "fixture/good"\n');
  await Bun.write(join(dataDir, "providers/fixture/models/bad.toml"), 'base_model = "fixture/bad"\n');
  return { root, dataDir, goodLab };
}

describe("latest upstream local compatibility isolation", () => {
  test("one semantic lab failure preserves good model inheritance and the original archive", async () => {
    const { root, dataDir, goodLab } = await fixture();
    try {
      // Valid v2 metadata still needs v2_only when its type cannot be represented in v1.
      const badLab = goodLab.replace("schema = 2", 'schema = 2\ntype = "extraction"');
      const badPath = join(dataDir, "models/fixture/bad.toml");
      await Bun.write(badPath, badLab);
      const diagnostics: { path: string; issues: unknown[] }[] = [];
      const result = await generateCompatibleModels(dataDir, diagnostics, join(root, "work"));
      expect(result.generationSucceeded).toBe(true);
      expect(result.generated.fixture?.models.good?.release_date).toBe("2024-05-13");
      expect(result.generated.fixture?.models.good?.canonical_id).toBe("fixture/good");
      expect(result.generated.fixture?.models.bad).toBeUndefined();
      expect(result.excluded.has("models/fixture/bad.toml")).toBe(true);
      expect(result.excluded.has("providers/fixture/models/bad.toml")).toBe(true);
      expect(result.excluded.has("providers/fixture/models/good.toml")).toBe(false);
      expect(await Bun.file(badPath).text()).toBe(badLab);
      expect(await Bun.file(join(dataDir, "providers/fixture/models/bad.toml")).text()).toBe('base_model = "fixture/bad"\n');
      expect(result.problems).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("a schema-incompatible lab and only its direct provider reference are isolated", async () => {
    const { root, dataDir, goodLab } = await fixture();
    try {
      await Bun.write(join(dataDir, "models/fixture/bad.toml"), 'unknown_new_lab_field = true\n' + goodLab);
      const diagnostics = [{ path: "models/fixture/bad.toml", issues: [{ path: ["unknown_new_lab_field"], message: "Unsupported fixture lab field" }] }];
      const result = await generateCompatibleModels(dataDir, diagnostics, join(root, "work"));
      expect(result.generationSucceeded).toBe(true);
      expect(Object.keys(result.generated.fixture!.models)).toEqual(["good"]);
      expect(result.generated.fixture?.models.good?.release_date).toBe("2024-05-13");
      expect(result.excluded.has("providers/fixture/models/bad.toml")).toBe(true);
      expect(diagnostics.some(file => file.path === "providers/fixture/models/bad.toml")).toBe(true);
      expect(await Bun.file(join(dataDir, "providers/fixture/models/bad.toml")).exists()).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test("N projection preserves inheritance, explicit override and omit without accepting new tool facts", async () => {
  const { root, dataDir, goodLab } = await fixture();
  try {
    await Bun.write(join(dataDir, "models/fixture/bad.toml"), goodLab);
    const unknownTools = '\n[api.responses.capabilities.tools]\nsearch = { supported = true }\n';
    const originals = new Map<string, string>();
    for (const [id, fields] of [
      ["inherited", 'base_model = "fixture/good"\n'],
      ["override", 'base_model = "fixture/good"\nrelease_date = "2025-06-04"\n'],
      ["omitted", 'base_model = "fixture/good"\nbase_model_omit = ["release_date"]\n'],
      ["override-omitted", 'base_model = "fixture/good"\nrelease_date = "2025-06-04"\nbase_model_omit = ["release_date"]\n'],
    ]) {
      const path = `providers/fixture/models/${id}.toml`;
      const tools = id === "override" ? unknownTools.replace("search =", "updates = false\nsearch =") : unknownTools;
      originals.set(path, fields + tools);
      await Bun.write(join(dataDir, path), fields + tools);
    }
    const diagnostics = [...originals].map(([path, body]) => {
      const parsed = AuthoredModelV2.safeParse({ ...Bun.TOML.parse(body), id: path.split("/").at(-1)!.slice(0, -5) });
      if (parsed.success) throw new Error("Fixture must exercise an unsupported tools field");
      return { path, issues: parsed.error.issues };
    });
    const result = await projectFixedParserDates(dataDir, diagnostics, join(root, "work"));
    const inherited = result.dates.get("providers/fixture/models/inherited.toml");
    expect(inherited?.release_date).toBe("2024-05-13");
    expect(inherited?.removed_fields).toEqual(["api.responses.capabilities.tools"]);
    expect(result.dates.get("providers/fixture/models/override.toml")?.release_date).toBe("2025-06-04");
    // search is now a known boolean; this unsupported shape removes its tools container.
    expect(result.dates.get("providers/fixture/models/override.toml")?.removed_fields).toEqual(["api.responses.capabilities.tools"]);
    expect(result.dates.has("providers/fixture/models/omitted.toml")).toBe(false);
    expect(result.dates.has("providers/fixture/models/override-omitted.toml")).toBe(false);
    expect(referenceReleaseDate(undefined, undefined, { release_date: "2025-06-04", base_model_omit: ["release_date"] }).date).toBeNull();
    expect(referenceReleaseDate(undefined, inherited?.release_date, {}).source).toBe("fixed_generator_n_projection");
    expect(inherited).not.toHaveProperty("capabilities");
    for (const [path, body] of originals) expect(await Bun.file(join(dataDir, path)).text()).toBe(body);
    expect(diagnostics).toHaveLength(4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("N projection refuses identity/date schema failures and fields outside tools", async () => {
  const { root, dataDir, goodLab } = await fixture();
  try {
    await Bun.write(join(dataDir, "models/fixture/bad.toml"), goodLab);
    const path = "providers/fixture/models/bad.toml";
    const body = 'base_model = "fixture/good"\nrelease_date = 42\n[api.responses.capabilities.tools]\nupdates = false\nsearch = { supported = true }\n';
    await Bun.write(join(dataDir, path), body);
    const parsed = AuthoredModelV2.safeParse({ ...Bun.TOML.parse(body), id: "bad" });
    if (parsed.success) throw new Error("Fixture must reject its date field");
    const result = await projectFixedParserDates(dataDir, [{ path, issues: parsed.error.issues }], join(root, "work"));
    expect(result.dates.size).toBe(0);
    expect(result.summary.eligible_records).toBe(0);
    const outside = await projectFixedParserDates(dataDir, [{ path, issues: [{ code: "unrecognized_keys", path: ["api", "responses", "compatibility"], keys: ["new_field"] }] }], join(root, "work"));
    expect(outside.dates.size).toBe(0);
    expect(await Bun.file(join(dataDir, path)).text()).toBe(body);
  } finally { await rm(root, { recursive: true, force: true }); }
});
