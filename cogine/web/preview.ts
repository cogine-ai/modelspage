import { resolve, sep } from "node:path";
import { filterCatalogByModelType, filterModelsByModelType, filterProvidersByModelType, InvalidModelTypeError, parseModelTypes } from "@models.dev/core";

// Serve the built files locally, including the original API query semantics.
const root = resolve(import.meta.dir, "../../packages/web/dist");
const catalogFile = Bun.file(resolve(root, "_catalog-all.json"));
if (!await catalogFile.exists()) throw new Error("Run bun run web:build before web:preview");
const catalog = await catalogFile.json();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8183),
  async fetch(request) {
    const url = new URL(request.url);
    if (["/api.json", "/models.json", "/catalog.json"].includes(url.pathname)) {
      try {
        const filter = parseModelTypes(url.searchParams.get("type"));
        return Response.json(url.pathname === "/api.json" ? filterProvidersByModelType(catalog.providers, filter) : url.pathname === "/models.json" ? filterModelsByModelType(catalog.models, filter) : filterCatalogByModelType(catalog, filter));
      } catch (error) {
        if (error instanceof InvalidModelTypeError) return Response.json({ error: error.message }, { status: 400 });
        throw error;
      }
    }
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response("Invalid path", { status: 400 }); }
    const relative = pathname === "/" ? "_index.html" : pathname === "/experimental/v2.0/api.json" ? "_experimental_v2.0_api.json" : pathname.slice(1);
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) return new Response("Not found", { status: 404 });
    let file = Bun.file(path);
    if (!await file.exists()) file = Bun.file(resolve(path, "index.html"));
    if (!await file.exists() && pathname.startsWith("/logos/")) file = Bun.file(resolve(root, "logos/default.svg"));
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    if (file.type.startsWith("text/html")) {
      const html = (await file.text()).replaceAll('content="/social-share.png"', `content="${url.origin}/social-share.png"`);
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response(file);
  },
});
console.log(`Modelspage local preview: http://${server.hostname}:${server.port}`);
