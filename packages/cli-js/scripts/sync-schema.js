// Copies the canonical schema from /schemas into this package before pack/test.
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "..", "schemas", "plugin-manifest.v1.schema.json");
const dstDir = join(here, "..", "schemas");
mkdirSync(dstDir, { recursive: true });
copyFileSync(src, join(dstDir, "plugin-manifest.v1.schema.json"));
