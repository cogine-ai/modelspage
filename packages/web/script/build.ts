#!/usr/bin/env bun

import { RenderedPages, Providers, Models, SearchIndexJson, renderDocument, AdditionalFiles } from "../src/render";
import {
  filterCatalogByModelType,
  generateV2,
  MODEL_TYPES,
  type ModelTypeFilter,
} from "@models.dev/core";
import fs from "fs/promises";
import path from "path";
import { licenseBanner, siteAssets } from "../../../cogine/web/site.ts";

await fs.rm("./dist", { recursive: true, force: true });
await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "dist",
  target: "bun",
  banner: licenseBanner,
});

for await (const file of new Bun.Glob("./public/*").scan()) {
  if (["./public/favicon.svg", "./public/social-share.png"].includes(file)) continue;
  await Bun.write(file.replace("./public/", "./dist/"), Bun.file(file));
}

for (const [route, source] of siteAssets) {
  await Bun.write(path.join("./dist", route.slice(1)), Bun.file(source));
}

// Copy provider logos to dist/logos/
await fs.mkdir("./dist/logos", { recursive: true });

// First, copy the default logo
const defaultLogoPath = "../../providers/logo.svg";
const defaultLogo = Bun.file(defaultLogoPath);
if (await defaultLogo.exists()) {
  await Bun.write("./dist/logos/default.svg", defaultLogo);
}

// Then copy provider-specific logos
const providersDir = "../../providers";
const entries = await fs.readdir(providersDir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory()) {
    const provider = entry.name;
    const logoPath = path.join(providersDir, provider, "logo.svg");
    const logoFile = Bun.file(logoPath);

    if (await logoFile.exists()) {
      await Bun.write(`./dist/logos/${provider}.svg`, logoFile);
    }
  }
}

// Copy lab logos to dist/logos/labs/
await fs.mkdir("./dist/logos/labs", { recursive: true });

const labsDir = "../../labs";
try {
  const labEntries = await fs.readdir(labsDir, { withFileTypes: true });
  for (const entry of labEntries) {
    if (entry.isDirectory()) {
      const lab = entry.name;
      const logoPath = path.join(labsDir, lab, "logo.svg");
      const logoFile = Bun.file(logoPath);

      if (await logoFile.exists()) {
        await Bun.write(`./dist/logos/labs/${lab}.svg`, logoFile);
      }
    }
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

const template = await Bun.file("./dist/index.html").text();

for (const [route, rendered] of RenderedPages) {
  const filePath = route === "/"
    ? "./dist/_index.html"
    : path.join("./dist", route, "index.html");

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, renderDocument(template, rendered));
}

await Bun.write("./dist/search-index.json", SearchIndexJson);

for (const [route, content] of AdditionalFiles) {
  await Bun.write(path.join("./dist", route.replace(/^\//, "")), content);
}

const catalog = { models: Models, providers: Providers };
const variants: Array<[suffix: string, filter: ModelTypeFilter]> = [
  ["", "default"],
  ["-all", "all"],
  ...MODEL_TYPES.map((type): [string, ModelTypeFilter] => [`-${type}`, [type]]),
];

for (const [suffix, filter] of variants) {
  const filtered = filterCatalogByModelType(catalog, filter);
  await Bun.write(`./dist/_api${suffix}.json`, JSON.stringify(filtered.providers));
  await Bun.write(`./dist/_models${suffix}.json`, JSON.stringify(filtered.models));
  await Bun.write(`./dist/_catalog${suffix}.json`, JSON.stringify(filtered));
}

const providersV2 = await generateV2(providersDir);
await Bun.write(
  "./dist/_experimental_v2.0_api.json",
  JSON.stringify(providersV2),
);

await fs.rm("./dist/index.html", { force: true });

if (process.env.MODELSPAGE_WEB_MODE === "public") {
  await fs.copyFile("./dist/_index.html", "./dist/index.html");
  await Bun.write("./dist/404.html", "<!doctype html><meta charset=\"utf-8\"><title>Not found | Modelspage</title><main><h1>Not found</h1><a href=\"/models\">Models</a></main>");
  const worker = await Bun.build({ entrypoints: ["../../cogine/web/worker.ts"], target: "browser", format: "esm", minify: true, banner: licenseBanner });
  if (!worker.success) throw new Error("Public web routing worker failed to build");
  await Bun.write("./dist/_worker.js", worker.outputs[0]!);
  await Bun.write("./dist/_routes.json", JSON.stringify({ version: 1, include: ["/*"], exclude: ["/logos/*", "/source-logos/*", "/licenses/*", "/*.js", "/*.css", "/favicon*.svg", "/social-share.png"] }));
}
