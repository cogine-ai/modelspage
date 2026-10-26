/** Run after an offline build: bun cogine/examples/consumer.ts [dist-directory]. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyRelease } from "../src/client.js";
import { filterIndex, project } from "../src/projection.js";
import { PUBLIC_SCOPE } from "../src/types.js";

const directory = resolve(process.argv[2] ?? "dist/fixture");
const manifest = JSON.parse(await readFile(resolve(directory, "v1/manifest.json"), "utf8"));
const release = await verifyRelease(manifest, async path => new Uint8Array(await readFile(resolve(directory, path))));
// The host supplies its actual selectable directory and exact connection scope.
// Public JSON never adds rows to this list or changes request IDs/routes/qualification.
const available = [
  { identity: { provider: "openrouter", request_model_id: "example-lab/model-v1", scope: { ...PUBLIC_SCOPE } }, display_name: "Host-owned model", free: false },
  { identity: { provider: "custom-local", request_model_id: "my-exact-model-id", scope: { ...PUBLIC_SCOPE, route: "custom" } }, display_name: "Private local selection", free: true },
];
const indexes = project(available, release.bundle, { popularity_source_id: "openrouter-weekly", now: release.manifest.published_at });
console.log(JSON.stringify({ revision: release.manifest.revision, modes: { C: indexes.capability, P: indexes.popularity, N: indexes.newest }, filteredFree: filterIndex(indexes.newest, { free_only: true }), explanations: indexes.explanations }, null, 2));
// Favorites are a separate user-owned list; preserve its order without applying these indexes.
// No network request occurs when opening the selector, sorting or filtering.
