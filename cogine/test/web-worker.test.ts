import { expect, test } from "bun:test";
import worker, { type Env } from "../web/worker.js";

const base = "https://models.example";
const hash = "a".repeat(64);
const revision = `/v1/revisions/${hash}/catalog.json`;
const uploaded = new Date("2026-10-27T02:17:00Z");
const chat = { name: "Text", cost: { input: 0, output: 2 } };
const image = { name: "Image", type: "image" };
const decision = { name: "Decision", type: "decision" };
const embedding = { name: "Embedding", type: "embedding" };
const modelGroups: Record<string, Record<string, object>> = {
  all: { chat, image, decision, embedding },
  default: { chat, image, embedding },
  chat: { chat }, image: { image }, decision: { decision }, embedding: { embedding },
};

function catalog(models: Record<string, object>) {
  const hosted = Object.fromEntries(Object.entries(models).map(([id, value]) => [id === "chat" ? "Vendor/Text:free" : id, value]));
  return { models, providers: { "Host-A": { name: "Host A", api: "https://host.example/v1", models: hosted } } };
}

type Stored = { body: string; etag?: string; cache?: string; uploaded?: Date; language?: string };
function environment() {
  const files = new Map<string, { body: string; type: string; etag?: string }>();
  for (const [group, models] of Object.entries(modelGroups)) {
    const suffix = group === "default" ? "" : `-${group}`;
    const value = catalog(models);
    files.set(`/_api${suffix}.json`, { body: JSON.stringify(value.providers), type: "application/json", etag: `"api${suffix}"` });
    files.set(`/_models${suffix}.json`, { body: JSON.stringify(value.models), type: "application/json", etag: `"models${suffix}"` });
    files.set(`/_catalog${suffix}.json`, { body: JSON.stringify(value), type: "application/json", etag: `"catalog${suffix}"` });
    const v2Models = catalog(group === "default" ? modelGroups.all! : models).providers["Host-A"].models;
    files.set(`/_experimental_v2.0_api${suffix}.json`, { body: JSON.stringify({ "V2-Host": { name: "V2 Host", models: v2Models } }), type: "application/json", etag: `"experimental${suffix}"` });
  }
  files.set("/logos/default.svg", { body: "<svg>default</svg>", type: "image/svg+xml" });
  files.set("/rankings", { body: "<h1>Rankings</h1>", type: "text/html" });
  files.set("/", { body: "<h1>Modelspage</h1>", type: "text/html" });
  const assetRequests: Request[] = [];
  const reads: string[] = [];
  const objects = new Map<string, Stored>();
  const env: Env = {
    ASSETS: {
      async fetch(request) {
        assetRequests.push(request);
        const file = files.get(new URL(request.url).pathname);
        if (!file) return new Response("Not found", { status: 404 });
        const headers = new Headers({ "Content-Type": file.type, "Cache-Control": "public, max-age=3600" });
        if (file.etag) headers.set("ETag", file.etag);
        if (file.etag && request.headers.get("If-None-Match") === file.etag) return new Response(null, { status: 304, headers });
        return new Response(file.body, { headers });
      },
    },
    PUBLIC_DATA: {
      async get(key) {
        reads.push(key);
        const value = objects.get(key);
        return value ? {
          body: new Response(value.body).body!, httpEtag: value.etag ?? '"object"',
          size: new TextEncoder().encode(value.body).length, uploaded: value.uploaded ?? uploaded,
          httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: value.cache, contentLanguage: value.language, contentDisposition: 'inline; filename="catalog.json"' },
        } : null;
      },
    },
  };
  return { env, files, assetRequests, reads, objects };
}
const request = (env: Env, path: string, init?: RequestInit) => worker.fetch(new Request(base + path, init), env);

test("public catalog APIs retain default, all, single, and multiple type semantics without changing request IDs", async () => {
  const { env, assetRequests } = environment();
  const defaultResponse = await request(env, "/catalog.json");
  const defaultCatalog = await defaultResponse.json();
  expect(Object.keys(defaultCatalog.models)).toEqual(["chat", "image", "embedding"]);
  expect(defaultCatalog.providers["Host-A"].models["Vendor/Text:free"]).toEqual(chat);
  expect(defaultResponse.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(Object.keys(await (await request(env, "/models.json?type=all")).json())).toEqual(["chat", "image", "decision", "embedding"]);
  const explicit = await (await request(env, "/api.json?type=decision")).json();
  expect(Object.keys(explicit["Host-A"].models)).toEqual(["decision"]);
  const multi = await (await request(env, "/catalog.json?type=chat,image,chat")).json();
  expect(Object.keys(multi.models)).toEqual(["chat", "image"]);
  expect(Object.keys(multi.providers["Host-A"].models)).toEqual(["Vendor/Text:free", "image"]);
  expect(assetRequests.every(value => new URL(value.url).search === "")).toBe(true);
});

test("catalog APIs combine repeated type parameters before filtering", async () => {
  const { env } = environment();
  const query = "?type=chat&type=image&type=chat";
  const api = await (await request(env, "/api.json" + query)).json();
  expect(Object.keys(api["Host-A"].models)).toEqual(["Vendor/Text:free", "image"]);
  expect(Object.keys(await (await request(env, "/models.json" + query)).json())).toEqual(["chat", "image"]);
  const combined = await (await request(env, "/catalog.json" + query)).json();
  expect(Object.keys(combined.models)).toEqual(["chat", "image"]);
  const schema = await (await request(env, "/model-schema.json" + query)).json();
  expect(schema.$defs.Model.enum).toEqual(["Host-A/Vendor/Text:free", "Host-A/image"]);
  expect((await request(env, "/api.json?type=chat&type=bogus")).status).toBe(400);
});

test("invalid type values fail before assets are read; prebuilt responses preserve conditional GET", async () => {
  const { env, assetRequests } = environment();
  for (const type of ["bogus", "all,chat", "Chat", "chat,"]) {
    const response = await request(env, `/api.json?type=${encodeURIComponent(type)}`);
    expect(response.status).toBe(400);
    expect((await response.json()).allowed).toContain("all");
  }
  expect(assetRequests).toHaveLength(0);
  const response = await request(env, "/models.json?type=all", { headers: { "If-None-Match": '"models-all"' } });
  expect(response.status).toBe(304);
  expect(response.headers.get("ETag")).toBe('"models-all"');
  expect(await response.text()).toBe("");
});

test("multi-type filtering caches only one artifact per assets binding, and does not forward an unrelated client ETag", async () => {
  const a = environment();
  await request(a.env, "/api.json?type=chat,image", { headers: { "If-None-Match": '"catalog-all"' } });
  await request(a.env, "/models.json?type=image,chat");
  expect(a.assetRequests).toHaveLength(1);
  expect(a.assetRequests[0]!.headers.get("If-None-Match")).toBeNull();
  const b = environment();
  b.files.set("/_catalog-all.json", { body: JSON.stringify(catalog({ image })), type: "application/json" });
  expect(Object.keys(await (await request(b.env, "/models.json?type=chat,image")).json())).toEqual(["image"]);
  expect(b.assetRequests).toHaveLength(1);
});

test("the public schema and experimental API remain available without the upstream deployment or telemetry", async () => {
  const { env } = environment();
  const schema = await (await request(env, "/model-schema.json?type=all")).json();
  expect(schema.$id).toBe(base + "/model-schema.json");
  expect(schema.$defs.Model.enum).toEqual(["Host-A/Vendor/Text:free", "Host-A/decision", "Host-A/embedding", "Host-A/image"]);
  const v2 = await (await request(env, "/experimental/v2.0/api.json")).json();
  expect(Object.keys(v2["V2-Host"].models)).toEqual(["Vendor/Text:free", "image", "decision", "embedding"]);
});

test("experimental v2 honors type filters while its default still includes every model", async () => {
  const { env } = environment();
  const explicit = await (await request(env, "/experimental/v2.0/api.json?type=decision")).json();
  expect(Object.keys(explicit["V2-Host"].models)).toEqual(["decision"]);
  const all = await (await request(env, "/experimental/v2.0/api.json?type=all")).json();
  expect(Object.keys(all["V2-Host"].models)).toEqual(["Vendor/Text:free", "image", "decision", "embedding"]);
  for (const query of ["?type=chat,image", "?type=chat&type=image&type=chat"]) {
    const response = await request(env, "/experimental/v2.0/api.json" + query);
    const value = await response.json();
    expect(Object.keys(value["V2-Host"].models)).toEqual(["Vendor/Text:free", "image"]);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  }
  const conditional = await request(env, "/experimental/v2.0/api.json?type=decision", { headers: { "If-None-Match": '"experimental-decision"' } });
  expect(conditional.status).toBe(304);
  expect(conditional.headers.get("ETag")).toBe('"experimental-decision"');
  const invalid = environment();
  expect((await request(invalid.env, "/experimental/v2.0/api.json?type=chat&type=bogus")).status).toBe(400);
  expect(invalid.assetRequests).toHaveLength(0);
});

test("manifest reads are fresh across requests, retain metadata, and never inherit immutable cache rules", async () => {
  const { env, objects, reads, assetRequests } = environment();
  objects.set("v1/manifest.json", { body: '{"sequence":1}', etag: '"manifest-1"', cache: "public, max-age=31536000, immutable" });
  const first = await request(env, "/v1/manifest.json");
  expect(await first.json()).toEqual({ sequence: 1 });
  expect(first.headers.get("ETag")).toBe('"manifest-1"');
  expect(first.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
  expect(first.headers.get("Last-Modified")).toBe(uploaded.toUTCString());
  objects.set("v1/manifest.json", { body: '{"sequence":2}', etag: '"manifest-2"' });
  const second = await request(env, "/v1/manifest.json", { headers: { "If-None-Match": '"manifest-1"' } });
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ sequence: 2 });
  expect(reads).toEqual(["v1/manifest.json", "v1/manifest.json"]);
  expect(assetRequests).toHaveLength(0);
});

test("R2 objects honor strong/weak ETag conditions and HTTP date precedence", async () => {
  const { env, objects } = environment();
  objects.set(revision.slice(1), { body: '{"revision":true}', etag: '"rev"' });
  const unchanged = await request(env, revision, { headers: { "If-None-Match": '"other", W/"rev"' } });
  expect(unchanged.status).toBe(304);
  expect(unchanged.headers.get("ETag")).toBe('"rev"');
  expect(unchanged.headers.get("Content-Length")).toBeNull();
  expect(await unchanged.text()).toBe("");
  expect((await request(env, revision, { headers: { "If-Match": 'W/"rev"' } })).status).toBe(412);
  const changed = await request(env, revision, { headers: { "If-Match": '"wrong"' } });
  expect(changed.status).toBe(412);
  expect(changed.headers.get("Cache-Control")).toBe("no-store");
  expect((await request(env, revision, { headers: { "If-Match": '"rev"' } })).status).toBe(200);
  expect((await request(env, revision, { headers: { "If-None-Match": '"wrong"', "If-Modified-Since": uploaded.toUTCString() } })).status).toBe(200);
  expect((await request(env, revision, { headers: { "If-Modified-Since": uploaded.toUTCString() } })).status).toBe(304);
  expect((await request(env, revision, { headers: { "If-Unmodified-Since": "Mon, 26 Oct 2026 02:17:00 GMT" } })).status).toBe(412);
});

test("revision GET/HEAD retain immutable metadata, byte length and the same ETag", async () => {
  const { env, objects } = environment();
  const body = '{"name":"模型"}';
  objects.set(revision.slice(1), { body, etag: '"rev"', cache: "public, max-age=31536000, immutable", language: "en" });
  const response = await request(env, revision);
  expect(await response.text()).toBe(body);
  expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  expect(response.headers.get("Content-Language")).toBe("en");
  expect(response.headers.get("Content-Disposition")).toBe('inline; filename="catalog.json"');
  const head = await request(env, revision, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(head.headers.get("Content-Length")).toBe(String(new TextEncoder().encode(body).length));
  expect(head.headers.get("ETag")).toBe(response.headers.get("ETag"));
  expect(head.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
});

test("only explicit public R2 paths can be read; missing objects are real 404s instead of SPA HTML", async () => {
  const { env, objects, reads, assetRequests } = environment();
  objects.set("v1/private.json", { body: "private fixture" });
  for (const path of ["/v1/private.json", "/v1/manifest.json/", "/v1/revisions/not-a-hash/catalog.json", "/v1/revisions/" + hash.toUpperCase() + "/catalog.json", "/v1/revisions/" + hash + "/other.json"]) {
    expect((await request(env, path)).status).toBe(404);
  }
  expect(reads).toHaveLength(0);
  expect((await request(env, "/v1/manifest.json")).status).toBe(404);
  expect(reads).toEqual(["v1/manifest.json"]);
  expect(assetRequests).toHaveLength(0);
});

test("storage faults and absent bindings cannot be mistaken for an empty first release", async () => {
  const { env } = environment();
  const broken: Env = { ...env, PUBLIC_DATA: { async get() { throw new Error("synthetic storage outage"); } } };
  expect((await request(broken, "/v1/manifest.json")).status).toBe(503);
  expect((await request({ ...env, PUBLIC_DATA: undefined } as unknown as Env, "/v1/manifest.json")).status).toBe(503);
});

test("static pages keep their URL state, missing logos fall back, and unknown pages remain 404", async () => {
  const { env, assetRequests, reads } = environment();
  expect(await (await request(env, "/")).text()).toContain("Modelspage");
  const ranking = await request(env, "/rankings?metric=capability&view=table");
  expect(await ranking.text()).toContain("Rankings");
  expect(assetRequests.at(-1)!.url).toBe(base + "/rankings?metric=capability&view=table");
  expect(await (await request(env, "/logos/unknown.svg")).text()).toBe("<svg>default</svg>");
  expect((await request(env, "/missing-page")).status).toBe(404);
  expect(reads).toHaveLength(0);
});

test("only GET/HEAD read data, and HEAD never returns a body for assets or APIs", async () => {
  const { env, reads, assetRequests } = environment();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await request(env, "/v1/manifest.json", { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  }
  expect(reads).toHaveLength(0);
  expect(assetRequests).toHaveLength(0);
  expect(await (await request(env, "/rankings", { method: "HEAD" })).text()).toBe("");
  expect(await (await request(env, "/api.json", { method: "HEAD" })).text()).toBe("");
});

test("a failed catalog asset can recover without keeping a poisoned isolate cache", async () => {
  const { env, files } = environment();
  files.delete("/_catalog-all.json");
  expect((await request(env, "/models.json?type=chat,image")).status).toBe(502);
  files.set("/_catalog-all.json", { body: JSON.stringify(catalog({ chat, image })), type: "application/json" });
  expect((await request(env, "/models.json?type=chat,image")).status).toBe(200);
});

test("public API and exact R2 paths permit read-only conditional CORS preflights without reading data", async () => {
  const { env, reads, assetRequests } = environment();
  for (const path of ["/api.json", "/models.json?type=all", "/catalog.json?type=chat,image", "/model-schema.json", "/experimental/v2.0/api.json", "/rankings.json", "/rankings.schema.json", "/v1/manifest.json", revision]) {
    const response = await request(env, path, { method: "OPTIONS", headers: { Origin: "https://consumer.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "if-none-match" } });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("If-None-Match, If-Modified-Since, If-Match, If-Unmodified-Since");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Cache-Control");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  }
  expect(reads).toHaveLength(0);
  expect(assetRequests).toHaveLength(0);
});

test("preflight never turns unknown pages, private R2 names, or malformed public paths into successful APIs", async () => {
  const { env, reads, assetRequests } = environment();
  for (const path of ["/models", "/missing", "/v1/private.json", "/v1/revisions/not-a-hash/catalog.json", "/rankings.schema.json/", "/v1/manifest.json/"]) {
    expect((await request(env, path, { method: "OPTIONS" })).status).toBe(404);
  }
  expect(reads).toHaveLength(0);
  expect(assetRequests).toHaveLength(0);
});

test("static public ranking datasets expose cache validators on GET/HEAD and preserve conditional responses", async () => {
  const { env, files } = environment();
  for (const path of ["/rankings.json", "/rankings.schema.json"]) {
    files.set(path, { body: '{"public":true}', type: "application/json", etag: '"public-data"' });
    const response = await request(env, path);
    expect(await response.json()).toEqual({ public: true });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Last-Modified");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Cache-Control");
    expect((await request(env, path, { headers: { "If-None-Match": '"public-data"' } })).status).toBe(304);
    expect(await (await request(env, path, { method: "HEAD" })).text()).toBe("");
    expect((await request(env, path, { method: "POST" })).status).toBe(405);
  }
});
