import { mkdir, readFile } from "node:fs/promises";
import { zodToJsonSchema } from "zod-to-json-schema";
import { bundleSchema, manifestSchema } from "../src/schema.js";
import { atomicWrite, stableStringify } from "../src/integrity.js";

await mkdir("cogine/schema", { recursive: true });
for (const [name, schema] of [["catalog", bundleSchema], ["manifest", manifestSchema]] as const) {
  const document = zodToJsonSchema(schema, { name, target: "jsonSchema7", $refStrategy: "root" });
  const content = stableStringify(document);
  const path = `cogine/schema/${name}.schema.json`;
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== content) throw new Error(`Outdated JSON schema: ${path}`);
  } else await atomicWrite(path, content);
}
console.log(process.argv.includes("--check") ? "JSON schemas match runtime contracts" : "Generated public JSON schemas; semantic checks additionally run in validateBundle/validateManifest");
