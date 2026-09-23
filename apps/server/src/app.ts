import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Config } from "./config.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** Builds the HTTP app. Kept free of listeners so tests can call it directly. */
export function createApp(config: Config): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/version", (c) =>
    c.json({ name: "openhoard", version: pkg.version, node: process.version }),
  );
  app.get("/", (c) =>
    c.json({
      name: "OpenHoard",
      tagline: "The AI filesystem that remembers everything and guards it all.",
      database: config.database.url === "pglite" ? "embedded (PGlite)" : "postgres",
    }),
  );

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}
