import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rankingLicensePath } from "./ranking-license.ts";

export const upstreamLicense = readFileSync(resolve(import.meta.dir, "../../LICENSE"), "utf8");
export const licensePath = "/licenses/models-dev.txt";
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
  return path.endsWith(".txt") ? "text/plain; charset=utf-8" : "application/json; charset=utf-8";
}
