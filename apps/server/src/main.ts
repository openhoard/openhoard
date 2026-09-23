import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// `--data-dir` overrides OPENHOARD_DATA_DIR; the dev script points it at the repo root.
const { values } = parseArgs({ options: { "data-dir": { type: "string" } }, strict: false });
const dataDir = typeof values["data-dir"] === "string" ? values["data-dir"] : undefined;
const config = loadConfig(dataDir ? { ...process.env, OPENHOARD_DATA_DIR: dataDir } : process.env);
mkdirSync(config.dataDir, { recursive: true });

const server = serve(
  { fetch: createApp(config).fetch, hostname: config.host, port: config.port },
  (info) => {
    console.log(
      `OpenHoard listening on http://${info.address}:${info.port} (data: ${config.dataDir})`,
    );
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
