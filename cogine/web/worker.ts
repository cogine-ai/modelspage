import {
  filterCatalogByModelType,
  filterModelsByModelType,
  filterProvidersByModelType,
  InvalidModelTypeError,
  MODEL_TYPES,
  parseModelTypes,
  type ModelTypeFilter,
  type ModelTypeValue,
} from "@models.dev/core/src/filter.js";

interface AssetBinding { fetch(request: Request): Promise<Response> }
interface PublicObject {
  body: ReadableStream<Uint8Array>;
  httpEtag: string;
  size: number;
  uploaded: Date;
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
    contentLanguage?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    cacheExpiry?: Date;
  };
}
export interface Env {
  ASSETS: AssetBinding;
  PUBLIC_DATA: { get(key: string): Promise<PublicObject | null> };
}

interface CatalogModel { type?: ModelTypeValue }
interface CatalogProvider { models: Record<string, CatalogModel> }
interface Catalog { models: Record<string, CatalogModel>; providers: Record<string, CatalogProvider> }
type Endpoint = "api" | "models" | "catalog";
const catalogCache = new WeakMap<AssetBinding, Promise<Catalog>>();
const manifestPath = "/v1/manifest.json";
const revisionPath = /^\/v1\/revisions\/[a-f0-9]{64}\/catalog\.json$/;
const manifestCache = "public, max-age=0, must-revalidate";
const revisionCache = "public, max-age=31536000, immutable";
const publicApis = new Set(["/api.json", "/models.json", "/catalog.json", "/model-schema.json", "/experimental/v2.0/api.json", "/rankings.json", "/rankings.schema.json"]);
const publicDataPath = (pathname: string) => publicApis.has(pathname) || pathname === manifestPath || revisionPath.test(pathname);

function cors(headers: Headers) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "ETag, Last-Modified, Cache-Control, Content-Length");
  return headers;
}

function json(value: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = cors(new Headers(headers));
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  if (status >= 400) responseHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function assetRequest(request: Request, pathname: string, clean = false) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return clean ? new Request(url, { method: "GET" }) : new Request(url, request);
}

async function fullCatalog(request: Request, assets: AssetBinding): Promise<Catalog> {
  let pending = catalogCache.get(assets);
  if (!pending) {
    pending = (async () => {
      const response = await assets.fetch(assetRequest(request, "/_catalog-all.json", true));
      if (!response.ok || response.headers.get("Content-Type")?.includes("text/html")) throw new Error("Catalog asset is unavailable");
      return await response.json() as Catalog;
    })();
    catalogCache.set(assets, pending);
    // A temporary asset error does not poison the isolate for later requests.
    void pending.catch(() => { if (catalogCache.get(assets) === pending) catalogCache.delete(assets); });
  }
  return pending;
}

async function catalogResponse(request: Request, env: Env, endpoint: Endpoint, filter: ModelTypeFilter) {
  const suffix = filter === "default" ? "" : filter === "all" ? "-all" : filter.length === 1 ? `-${filter[0]}` : null;
  if (suffix !== null) {
    const response = await env.ASSETS.fetch(assetRequest(request, `/_${endpoint}${suffix}.json`));
    if (!response.ok && response.status !== 304) return json({ error: "Catalog data is unavailable" }, response.status);
    if (response.headers.get("Content-Type")?.includes("text/html")) return json({ error: "Catalog data is unavailable" }, 404);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: cors(new Headers(response.headers)) });
  }
  const catalog = await fullCatalog(request, env.ASSETS);
  const value = endpoint === "api" ? filterProvidersByModelType(catalog.providers, filter)
    : endpoint === "models" ? filterModelsByModelType(catalog.models, filter)
      : filterCatalogByModelType(catalog, filter);
  return json(value, 200, { "Cache-Control": "public, max-age=3600" });
}

function etagMatches(header: string, etag: string, weak: boolean) {
  const normalized = (value: string) => weak ? value.replace(/^W\//, "") : value;
  return header.split(",").some(value => {
    const candidate = value.trim();
    return candidate === "*" || (!weak && candidate.startsWith("W/") ? false : normalized(candidate) === normalized(etag));
  });
}

function conditionStatus(request: Request, object: PublicObject): 200 | 304 | 412 {
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch && !etagMatches(ifMatch, object.httpEtag, false)) return 412;
  const modified = Math.floor(object.uploaded.getTime() / 1000) * 1000;
  const unmodifiedSince = Date.parse(request.headers.get("If-Unmodified-Since") ?? "");
  if (!ifMatch && Number.isFinite(unmodifiedSince) && modified > unmodifiedSince) return 412;
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && etagMatches(ifNoneMatch, object.httpEtag, true)) return 304;
  const modifiedSince = Date.parse(request.headers.get("If-Modified-Since") ?? "");
  if (!ifNoneMatch && Number.isFinite(modifiedSince) && modified <= modifiedSince) return 304;
  return 200;
}

async function publicDataResponse(request: Request, env: Env) {
  const pathname = new URL(request.url).pathname;
  if (pathname !== manifestPath && !revisionPath.test(pathname)) return json({ error: "Not found" }, 404);
  if (!env.PUBLIC_DATA) return json({ error: "Public data storage is unavailable" }, 503);
  let object: PublicObject | null;
  try { object = await env.PUBLIC_DATA.get(pathname.slice(1)); }
  catch { return json({ error: "Public data is temporarily unavailable" }, 503); }
  if (!object) return json({ error: "Not found" }, 404);
  const metadata = object.httpMetadata;
  const headers = cors(new Headers({
    "Content-Type": metadata?.contentType ?? "application/json; charset=utf-8",
    "Cache-Control": pathname === manifestPath ? manifestCache : metadata?.cacheControl ?? revisionCache,
    ETag: object.httpEtag,
    "Content-Length": String(object.size),
    "Last-Modified": object.uploaded.toUTCString(),
  }));
  if (metadata?.contentLanguage) headers.set("Content-Language", metadata.contentLanguage);
  if (metadata?.contentDisposition) headers.set("Content-Disposition", metadata.contentDisposition);
  if (metadata?.contentEncoding) headers.set("Content-Encoding", metadata.contentEncoding);
  if (metadata?.cacheExpiry && pathname !== manifestPath) headers.set("Expires", metadata.cacheExpiry.toUTCString());
  const status = conditionStatus(request, object);
  if (status !== 200) {
    await object.body.cancel();
    headers.delete("Content-Length");
    if (status === 412) headers.set("Cache-Control", "no-store");
    return new Response(null, { status, headers });
  }
  return new Response(object.body, { headers });
}

async function route(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/v1/")) return publicDataResponse(request, env);
  const endpoint: Endpoint | undefined = url.pathname === "/api.json" ? "api" : url.pathname === "/models.json" ? "models" : url.pathname === "/catalog.json" ? "catalog" : undefined;
  if (endpoint || url.pathname === "/model-schema.json") {
    let filter: ModelTypeFilter;
    try { filter = parseModelTypes(url.searchParams.get("type")); }
    catch (error) {
      if (!(error instanceof InvalidModelTypeError)) throw error;
      return json({ error: error.message, allowed: [...MODEL_TYPES, "all"] }, 400);
    }
    if (endpoint) return catalogResponse(request, env, endpoint, filter);
    const catalog = await fullCatalog(request, env.ASSETS);
    const providers = filterProvidersByModelType(catalog.providers, filter);
    return json({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: new URL("/model-schema.json", url).href,
      $defs: { Model: { type: "string", enum: Object.entries(providers).flatMap(([provider, value]) => Object.keys(value.models).map(model => `${provider}/${model}`)).sort(), description: "AI model identifier in provider/model format" } },
    }, 200, { "Cache-Control": "public, max-age=3600" });
  }
  if (url.pathname === "/experimental/v2.0/api.json") return env.ASSETS.fetch(assetRequest(request, "/_experimental_v2.0_api.json"));
  const response = await env.ASSETS.fetch(request);
  return response.status === 404 && url.pathname.startsWith("/logos/")
    ? env.ASSETS.fetch(assetRequest(request, "/logos/default.svg")) : response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method === "OPTIONS") {
      if (!publicDataPath(pathname)) return json({ error: "Not found" }, 404);
      const headers = cors(new Headers({
        "Access-Control-Allow-Methods": "GET, HEAD",
        "Access-Control-Allow-Headers": "If-None-Match, If-Modified-Since, If-Match, If-Unmodified-Since",
      }));
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405, { Allow: "GET, HEAD" });
    let response: Response;
    try { response = await route(request, env); }
    catch { response = json({ error: "Catalog data is temporarily unavailable" }, 502); }
    if (publicDataPath(pathname)) response = new Response(response.body, { status: response.status, statusText: response.statusText, headers: cors(new Headers(response.headers)) });
    if (request.method === "HEAD" && response.body) {
      await response.body.cancel();
      return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return response;
  },
};
