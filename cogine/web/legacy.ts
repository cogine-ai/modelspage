import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { legacyResolver } from "../src/legacy.js";

export const legacy = legacyResolver(JSON.parse(readFileSync(resolve(import.meta.dir, "../config/legacy-models.json"), "utf8")));
