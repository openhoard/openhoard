import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * Server configuration. Precedence: environment (OPENHOARD_*) > <dataDir>/config.json > defaults.
 * No Docker, no external services required: defaults run a single node with embedded storage.
 *
 * The schema is STRICT (security review #12): unknown keys are errors, so a typo such as
 * `"prot": 9000` fails loudly instead of silently running with the default.
 */
export const ConfigSchema = z
  .object({
    host: z.string().default("127.0.0.1"),
    port: z.coerce.number().int().min(0).max(65535).default(7420),
    dataDir: z.string().default(".openhoard"),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    database: z
      .object({
        /** "pglite" for dev and single-node trials, a postgres:// URL for production. */
        url: z.string().default("pglite"),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const dataDir = resolve(cwd, env.OPENHOARD_DATA_DIR ?? ".openhoard");
  const file = join(dataDir, "config.json");
  let fromFile: unknown = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`invalid OpenHoard config:\n  ${file}: ${(e as Error).message}`, {
        cause: e,
      });
    }
  }
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
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid OpenHoard config:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

/**
 * Creates the data directory readable only by the service user (security review #9): it holds
 * the database, blobs and keys. On POSIX we also tighten an existing directory to 0700.
 * On Windows, mode bits are ignored; the directory inherits the user profile's ACLs, and
 * `openhoard service install` (T-1102) sets an explicit ACL for the service account.
 */
export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
