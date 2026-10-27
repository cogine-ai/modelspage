import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "../src/build.ts";

const root = resolve(import.meta.dir, "../..");
const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { "published-at": { type: "string" } } });
const origin = process.env.MODELSPAGE_WEB_ORIGIN;
if (!origin || new URL(origin).protocol !== "https:") throw new Error("Set MODELSPAGE_WEB_ORIGIN to the actual public HTTPS site origin");
const commit = Bun.spawn(["git", "show", "-s", "--format=%cI", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
const clock = values["published-at"] ?? (await new Response(commit.stdout).text()).trim();
if (await commit.exited) throw new Error("Unable to resolve the reviewed commit build clock");
const outDir = resolve(root, "dist/web-production-data");
const { bundle } = await build({ root, publishedAt: clock, sequence: 1, outDir });
const catalog = resolve(outDir, `v1/revisions/${bundle.revision}/catalog.json`);
const child = Bun.spawn([process.execPath, "script/build.ts"], {
  cwd: resolve(root, "packages/web"),
  env: { ...process.env, MODELSPAGE_WEB_MODE: "public", MODELSPAGE_WEB_CATALOG: catalog },
  stdout: "inherit", stderr: "inherit",
});
if (await child.exited) throw new Error("Public website build failed; deployment was not attempted");
console.log(JSON.stringify({ public_origin: origin, ranking_revision: bundle.revision, output: "packages/web/dist", publication: "web-assets; versioned R2 publication is separate" }));
