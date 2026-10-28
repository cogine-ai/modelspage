import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "../src/build.ts";
import { atomicWrite } from "../src/integrity.ts";
import { validateWebRankingDataset } from "./schema.ts";
import { readPublicBytes } from "../src/request.ts";

const root = resolve(import.meta.dir, "../..");
const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: { "published-at": { type: "string" } } });
const origin = process.env.MODELSPAGE_WEB_ORIGIN;
if (!origin || new URL(origin).protocol !== "https:") throw new Error("Set MODELSPAGE_WEB_ORIGIN to the actual public HTTPS site origin");
const pin = (await Bun.file(resolve(root, "cogine/upstream.lock.json")).json()).commit;
if (typeof pin !== "string" || !/^[a-f0-9]{40}$/.test(pin)) throw new Error("Invalid fixed upstream commit");
const present = Bun.spawn(["git", "cat-file", "-e", `${pin}^{commit}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
if (await present.exited) {
  const fetched = Bun.spawn(["git", "fetch", "--no-tags", "--depth=1", "origin", pin], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (await fetched.exited) throw new Error("The fixed upstream input could not be fetched");
}
const commit = Bun.spawn(["git", "show", "-s", "--format=%cI", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
const clock = values["published-at"] ?? (await new Response(commit.stdout).text()).trim();
if (await commit.exited) throw new Error("Unable to resolve the reviewed commit build clock");
const outDir = resolve(root, "dist/web-production-data");
let previousPath: string | undefined;
const { response: current, bytes } = await readPublicBytes(new URL("/rankings.json", origin), { allowNotFound: true, onEvent: public_read => console.error(JSON.stringify({ public_read })) });
if (current.status !== 404) {
  const text = new TextDecoder().decode(bytes);
  const previous = validateWebRankingDataset(JSON.parse(text));
  if (previous.audience !== "public") throw new Error("The current website is not a public data release");
  previousPath = resolve(outDir, "previous-rankings.json");
  await atomicWrite(previousPath, text);
}
const { bundle } = await build({ root, publishedAt: clock, sequence: 1, outDir });
const catalog = resolve(outDir, `v1/revisions/${bundle.revision}/catalog.json`);
const child = Bun.spawn([process.execPath, "script/build.ts"], {
  cwd: resolve(root, "packages/web"),
  env: { ...process.env, MODELSPAGE_WEB_MODE: "public", MODELSPAGE_WEB_CATALOG: catalog, MODELSPAGE_WEB_PREVIOUS_RANKINGS: previousPath },
  stdout: "inherit", stderr: "inherit",
});
if (await child.exited) throw new Error("Public website build failed; deployment was not attempted");
const published = await Bun.file(resolve(root, "packages/web/dist/rankings.json")).json();
console.log(JSON.stringify({ public_origin: origin, ranking_revision: published.revision, input_revision: bundle.revision, output: "packages/web/dist", publication: "web-assets; versioned R2 publication is separate" }));
