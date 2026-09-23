import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * Server configuration. Precedence: environment (OPENHOARD_*) > <dataDir>/config.json > defaults.
 * No Docker, no external services required: defaults run a single node with embedded storage.
 */
export const ConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().min(0).max(65535).default(7420),
  dataDir: z.string().default(".openhoard"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  database: z
    .object({
      /** "pglite" for dev and single-node trials, a postgres:// URL for production. */
      url: z.string().default("pglite"),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const dataDir = resolve(cwd, env.OPENHOARD_DATA_DIR ?? ".openhoard");
  const file = join(dataDir, "config.json");
  const fromFile: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const fileObj = typeof fromFile === "object" && fromFile !== null ? fromFile : {};

  const fromEnv = stripUndefined({
    host: env.OPENHOARD_HOST,
    port: env.OPENHOARD_PORT,
    logLevel: env.OPENHOARD_LOG_LEVEL,
  });
  const dbUrl = env.OPENHOARD_DATABASE_URL;

  const merged = {
    ...fileObj,
    ...fromEnv,
    dataDir,
    ...(dbUrl ? { database: { url: dbUrl } } : {}),
  };
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid OpenHoard config:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
