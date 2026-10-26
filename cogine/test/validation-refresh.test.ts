import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRegistry, continuation, parseModels, runRefresh, validationCredential } from "../scripts/validation/refresh.js";

type Provider = Parameters<typeof parseModels>[1];
const provider = (id: string, discovery_strategy = "openai_models"): Provider => ({ id, name: id, discovery_strategy, refresh_urls: [], fallback_models: [] });
const endpoint = new URL("https://catalog.example/models");
function withEnvironment(values: Record<string, string | undefined>, action: () => void) {
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } action(); }
  finally { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

describe("source-derived Provider refresh validation", () => {
  test("follows declared URL, Anthropic cursor and Gemini token contracts", () => {
    expect(continuation({ has_more: true, last_id: "Exact/ID" }, endpoint).next).toBe("https://catalog.example/models?after_id=Exact%2FID");
    expect(continuation({ nextPageToken: "a+b" }, endpoint).next).toBe("https://catalog.example/models?pageToken=a%2Bb");
    expect(continuation({ links: [{ rel: "next", href: "/page/2" }] }, endpoint).next).toBe("https://catalog.example/page/2");
    expect(continuation({ has_more: false, complete: true, links: { next: null } }, endpoint)).toEqual({});
  });

  test("unknown, nested, invalid or contradictory continuation never claims completeness", () => {
    for (const response of [{ next_page: 2 }, { hasNext: true }, { has_more: "false" }, { complete: null }, { metadata: { meta: { nextCursor: "opaque" } } }, { links: { next: "/p2" }, metadata: { truncated: true } }, { links: { next: "/p2" }, next_page_url: "/p3" }, { meta: { errors: ["source error"] } }]) {
      expect(continuation(response, endpoint).unresolved).toBeTruthy();
    }
  });

  test("duplicate identities follow each client contract without losing exact listed membership", () => {
    const duplicate = { data: [{ id: "Same-ID" }, { id: "Same-ID", name: "Later" }] };
    const generic = parseModels(duplicate, provider("openai"));
    expect(generic.listed).toEqual(["Same-ID"]);
    expect(generic.models[0]!.name).toBe("Same-ID");
    expect(generic.issues[0]!.code).toBe("duplicate_model_identity");
    for (const id of ["opencode", "opencode-go", "coginellm"]) expect(() => parseModels(duplicate, provider(id))).toThrow("duplicate");
    expect(() => parseModels({ data: [{ id: "dup", supported_protocols: [] }, { id: "dup", supported_protocols: [] }] }, provider("tokendance"))).toThrow("duplicate");
  });

  test("generic client skips missing IDs while complete-catalog gateways reject malformed rows", () => {
    const result = parseModels({ data: [null, {}, { id: "" }, { id: "still-present" }] }, provider("openai"));
    expect(result.models.map(row => row.id)).toEqual(["still-present"]);
    expect(result.issues.every(issue => issue.code === "client_skips_missing_identity")).toBe(true);
    for (const id of ["openrouter", "kilo", "opencode"]) expect(() => parseModels({ data: [{}] }, provider(id))).toThrow("identity");
  });

  test("Gemini filters generation support before choosing the first eligible duplicate", () => {
    const result = parseModels({ models: [
      { name: "models/Exact-Model", supportedGenerationMethods: ["embedContent"] },
      { name: "models/Exact-Model", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
      { name: "models/" },
    ] }, provider("gemini", "gemini_models"));
    expect(result.listed).toEqual(["Exact-Model", "embedding"]);
    expect(result.models.map(row => row.id)).toEqual(["Exact-Model"]);
  });

  test("TokenDance protocol filtering and packaged Cogine Free stay distinct from raw membership", () => {
    const result = parseModels({ data: [
      { id: "chat", supported_protocols: ["openai:chat-completions"] },
      { id: "responses", supported_protocols: ["openai:responses"] },
    ] }, provider("tokendance"));
    expect(result.listed).toEqual(["chat", "responses"]);
    expect(result.models.map(row => row.id)).toEqual(["chat"]);
    expect(() => parseModels({ data: [] }, provider("tokendance"))).toThrow("empty");
    expect(() => parseModels({ data: [{ id: "bad", supported_protocols: [123] }] }, provider("tokendance"))).toThrow("supported_protocols");
    const cogine = parseModels({ data: [{ id: "cogine/free" }, { id: "paid" }] }, provider("coginellm"));
    expect(cogine.listed).toEqual(["cogine/free", "paid"]);
    expect(cogine.models.map(row => row.id)).toEqual(["paid"]);
  });

  test("case, punctuation, date, free/cloud and quantization semantics remain in request IDs", () => {
    const ids = ["Lab/Model-2026-10-26", "lab/model-2026-10-26", "Lab/Model:free", "Lab/Model:cloud", "Lab/Model-Q4_K_M"];
    expect(parseModels({ data: ids.map(id => ({ id })) }, provider("openai")).models.map(row => row.id)).toEqual(ids);
    const trimmed = parseModels({ data: [{ id: "  Exact-ID:free  " }] }, provider("openai"));
    expect(trimmed.listed).toEqual(["Exact-ID:free"]);
    expect(trimmed.issues[0]!.model_id).toBe("  Exact-ID:free  ");
  });

  test("owned_by is preserved only as an explicit source string without guessing or normalization", () => {
    const result = parseModels({ data: [
      { id: "lab/model", owned_by: "openrouter" },
      { id: "lab/model:free", owned_by: " OpenRouter " },
      { id: "missing" },
      { id: "number", owned_by: 123 },
      { id: "empty", owned_by: "" },
    ] }, provider("coginellm"));
    expect(result.models[0]!.owned_by).toBe("openrouter");
    expect(result.models[1]!.owned_by).toBe(" OpenRouter ");
    expect(result.models[2]).not.toHaveProperty("owned_by");
    expect(result.models[3]).not.toHaveProperty("owned_by");
    expect(result.models[4]!.owned_by).toBe("");
    expect(result.models.map(row => row.id)).toEqual(["lab/model", "lab/model:free", "missing", "number", "empty"]);
  });

  test("Zen keeps unknown membership and uses each exact registry transport", () => {
    const issues: Parameters<typeof applyRegistry>[3] = [];
    const result = applyRegistry(provider("opencode"), [{ id: "known" }, { id: "unmapped" }], { opencode: {
      id: "opencode", api: "https://opencode.ai/inference/openai/v1", npm: "@ai-sdk/openai-compatible", models: {
        known: { id: "known", provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/anthropic/v1" }, modalities: { input: ["text"], output: ["text"] } },
      },
    } }, issues);
    expect(result.map(row => [row.id, row.model_protocol])).toEqual([["known", "anthropic_messages"], ["unmapped", "unknown"]]);
    expect(issues[0]!.code).toBe("unknown_registry_contract");
  });

  test("Go projects supported text chat contracts and only exact immutable seeds", () => {
    const go = provider("opencode-go");
    go.fallback_models = [{ id: "seed:free", name: "Seed", model_protocol: "chat_completions", supports_text_output: true }];
    const issues: Parameters<typeof applyRegistry>[3] = [];
    const metadata = (id: string, npm: string, output = ["text"]) => ({ id, provider: { npm }, modalities: { input: ["text"], output } });
    const result = applyRegistry(go, ["chat", "responses", "image", "seed:free", "seed", "unknown"].map(id => ({ id })), { "opencode-go": {
      id: "opencode-go", models: { chat: metadata("chat", "@ai-sdk/openai-compatible"), responses: metadata("responses", "@ai-sdk/openai"), image: metadata("image", "@ai-sdk/openai-compatible", ["image"]) },
    } }, issues);
    expect(result.map(row => row.id)).toEqual(["chat", "seed:free"]);
    expect(result[1]!.metadata_basis).toBe("immutable_packaged_protocol_seed");
    expect(issues.filter(issue => issue.code === "client_excludes_unknown_registry_contract").map(issue => issue.model_id)).toEqual(["seed", "unknown"]);
  });

  test("credential reuse is limited to OpenAI Response's explicit OpenAI fallback", () => {
    withEnvironment({ MODELSPAGE_VALIDATE_OPENAI_API_KEY: "synthetic-openai", MODELSPAGE_VALIDATE_OPENAI_RESPONSE_API_KEY: undefined, MODELSPAGE_VALIDATE_KIMI_CN_API_KEY: "synthetic-cn", MODELSPAGE_VALIDATE_KIMI_INTL_API_KEY: undefined, MODELSPAGE_VALIDATE_KIMI_CODINGPLAN_API_KEY: undefined }, () => {
      expect(validationCredential(provider("openai-response"))).toEqual({ name: "MODELSPAGE_VALIDATE_OPENAI_API_KEY", key: "synthetic-openai" });
      expect(validationCredential(provider("kimi-intl"))).toEqual({ name: null, key: undefined });
      expect(validationCredential(provider("kimi-codingplan"))).toEqual({ name: null, key: undefined });
      process.env.MODELSPAGE_VALIDATE_OPENAI_RESPONSE_API_KEY = "synthetic-responses";
      expect(validationCredential(provider("openai-response")).name).toBe("MODELSPAGE_VALIDATE_OPENAI_RESPONSE_API_KEY");
      process.env.MODELSPAGE_VALIDATE_OPENAI_RESPONSE_API_KEY = "invalid\nheader";
      expect(() => validationCredential(provider("openai-response"))).toThrow("Invalid multiline");
    });
  });

  test("one malformed credential records its own failure without cancelling other Provider statuses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "modelspage-refresh-"));
    const prior = process.env.MODELSPAGE_VALIDATE_SYNTHETIC_API_KEY;
    try {
      process.env.MODELSPAGE_VALIDATE_SYNTHETIC_API_KEY = "invalid\nheader";
      const input = join(directory, "inventory.json"), out = join(directory, "out");
      await writeFile(input, JSON.stringify({ coginework: { head: "fixture" }, providers: [provider("synthetic"), { ...provider("ollama"), is_local: true, fallback_models: [{ id: "local:Q4" }] }] }));
      const index = await runRefresh(input, out);
      expect(index.counts).toEqual({ configuration_error: 1, not_run_local: 1 });
      const local = JSON.parse(await readFile(join(out, "ollama.json"), "utf8"));
      expect(local.fallback).toMatchObject({ latest: false, models: [{ id: "local:Q4" }] });
      expect(local.requests).toEqual([]);
      expect(local.inventory_sha256).toBe(index.input_sha256);
    } finally { if (prior === undefined) delete process.env.MODELSPAGE_VALIDATE_SYNTHETIC_API_KEY; else process.env.MODELSPAGE_VALIDATE_SYNTHETIC_API_KEY = prior; await rm(directory, { recursive: true, force: true }); }
  });
});
