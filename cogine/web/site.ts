import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rankingLicensePath } from "./ranking-license.ts";

export const upstreamLicense = readFileSync(resolve(import.meta.dir, "../../LICENSE"), "utf8");
export const licensePath = "/licenses/models-dev.txt";
export const canonicalOrigin = "https://models.cogine.ai";
export const licenseBanner = `/*!\n${upstreamLicense.trim()}\n*/`;
export const siteAssets = new Map([
  ["/favicon.svg", resolve(import.meta.dir, "assets/favicon.svg")],
  ["/social-share.png", resolve(import.meta.dir, "assets/social-share.png")],
  ["/source-logos/artificial-analysis.svg", resolve(import.meta.dir, "assets/artificial-analysis.svg")],
  [rankingLicensePath, resolve(import.meta.dir, "licenses/rankings-v1.0.txt")],
]);

export function socialImageUrl(requestOrigin?: string) {
  const origin = process.env.MODELSPAGE_WEB_ORIGIN || requestOrigin;
  if (process.env.MODELSPAGE_WEB_MODE === "public") {
    const url = origin ? new URL(origin) : null;
    if (!url || url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Public web builds require a public HTTPS origin");
  }
  return origin ? new URL("/social-share.png", origin).href : "/social-share.png";
}

export function additionalContentType(path: string) {
  if (path.endsWith(".xml")) return "application/xml; charset=utf-8";
  return path.endsWith(".txt") ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
}

export function canonicalPageUrl(route: string) {
  const path = route === "/" ? route : `${route.replace(/\/$/, "")}/`;
  return new URL(canonicalOrigin + path).href;
}

export function pageSitemap(routes: Iterable<string>) {
  const entries = [...routes].sort().map(route => {
    const url = canonicalPageUrl(route).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return `  <url><loc>${url}</loc></url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
}
