#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isConnectorError } from "@openhoard/sdk";
import { graphAuth, GraphAuthError, type ClientCredential } from "./auth.js";
import { probeSites, sitePath } from "./probe.js";

/*
 * Checks an app registration against a real tenant (T-302's run on a dev tenant):
 *
 *   node dist/check.js <site>…
 *
 * with, in the environment (never on the command line, which other programs can read):
 *
 *   OPENHOARD_GRAPH_TENANT             the tenant's id or domain
 *   OPENHOARD_GRAPH_CLIENT_ID          the app's client id
 *   OPENHOARD_GRAPH_CLIENT_SECRET      a client secret's value, or the two below
 *   OPENHOARD_GRAPH_CERTIFICATE_FILE   the certificate, PEM
 *   OPENHOARD_GRAPH_PRIVATE_KEY_FILE   its private key, PEM
 *   OPENHOARD_GRAPH_USER_TOKEN_FILE    optional: a file holding a user's access token for this
 *                                      app, to try the on-behalf-of exchange too
 *   OPENHOARD_GRAPH_AUTHORITY, OPENHOARD_GRAPH_URL   optional: a national cloud's addresses
 *
 * It gets an app-only token, asks Graph for each site, and says what came back. It prints no
 * token and no secret. Exit status: 0 when every site is reached (and the exchange worked, if
 * tried), 1 otherwise, 2 for a mistake in how it was run (an argument, a variable, a file).
 */

const env = (name: string) => process.env[`OPENHOARD_GRAPH_${name}`]?.trim() ?? "";
const usage = (why: string): never => {
  console.error(
    `${shown(why)}\n\nusage: node dist/check.js <site>…   (see the README: "Checking a tenant")`,
  );
  process.exit(2);
};

/** Text from Graph or a token, safe to print: no control characters, not endless. */
const shown = (value: unknown): string =>
  [...String(value ?? "?")]
    .filter((ch) => {
      const code = ch.codePointAt(0) as number;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .join("")
    .slice(0, 200);

/** What a token says about itself, for showing; nothing here is trusted. */
function claimsOf(jwt: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function main(): Promise<number> {
  const sites = process.argv.slice(2);
  if (sites.length === 0 || sites.some((s) => s.startsWith("-"))) {
    usage("name the sites to check");
  }
  /** A mistake in the setup is said as one, with the variable to look at. */
  const setup = <T>(what: string, make: () => T): T => {
    try {
      return make();
    } catch (e) {
      return usage(`${what}: ${(e as Error).message}`);
    }
  };
  setup("sites", () => sites.forEach(sitePath));
  const tenant = env("TENANT");
  const clientId = env("CLIENT_ID");
  if (tenant === "" || clientId === "") {
    usage("set OPENHOARD_GRAPH_TENANT and OPENHOARD_GRAPH_CLIENT_ID");
  }
  const file = (name: string): string => {
    try {
      return readFileSync(env(name), "utf8");
    } catch (e) {
      // The reason, not the path or anything of the file.
      const code = (e as NodeJS.ErrnoException).code ?? "unreadable";
      return usage(`OPENHOARD_GRAPH_${name} can't be read (${code})`);
    }
  };
  let credential: ClientCredential;
  if (env("CERTIFICATE_FILE") !== "" || env("PRIVATE_KEY_FILE") !== "") {
    if (env("CERTIFICATE_FILE") === "" || env("PRIVATE_KEY_FILE") === "") {
      usage(
        "a certificate needs both OPENHOARD_GRAPH_CERTIFICATE_FILE and OPENHOARD_GRAPH_PRIVATE_KEY_FILE",
      );
    }
    if (env("CLIENT_SECRET") !== "") {
      usage("set a client secret or a certificate, not both");
    }
    credential = {
      kind: "certificate",
      certificate: file("CERTIFICATE_FILE"),
      privateKey: file("PRIVATE_KEY_FILE"),
    };
  } else if (env("CLIENT_SECRET") !== "") {
    credential = { kind: "secret", secret: env("CLIENT_SECRET") };
  } else {
    return usage("set OPENHOARD_GRAPH_CLIENT_SECRET, or the certificate and key files");
  }
  const assertion = env("USER_TOKEN_FILE") === "" ? undefined : file("USER_TOKEN_FILE").trim();

  const auth = setup("the app's settings", () =>
    graphAuth({
      tenant,
      clientId,
      credential,
      ...(env("AUTHORITY") === "" ? {} : { authority: env("AUTHORITY") }),
      ...(env("URL") === "" ? {} : { graph: env("URL") }),
    }),
  );
  const signal = AbortSignal.timeout(120_000);
  let failed = false;

  const app = claimsOf(await auth.appToken(signal));
  const roles = Array.isArray(app.roles) ? shown(app.roles.join(", ")) : "";
  console.log(`app-only token: issued (${credential.kind})`);
  console.log(`  permissions: ${roles === "" ? "none in the token" : roles}`);
  if (!/\bSites\.Selected\b/.test(roles)) {
    console.log("  note: Sites.Selected isn't among them; OpenHoard needs no more than that");
  }

  for (const probe of await probeSites(auth, sites, signal)) {
    if (probe.status === "ok") {
      console.log(`site ${probe.site}: reached (${shown(probe.name)}, ${shown(probe.webUrl)})`);
      console.log(`  id: ${shown(probe.id)}`);
    } else {
      failed = true;
      console.log(
        probe.status === "denied"
          ? `site ${probe.site}: REFUSED. The app isn't granted this site (Sites.Selected is granted site by site), or lacks the permission.`
          : `site ${probe.site}: NOT FOUND. Check the host and path, or the id.`,
      );
    }
  }

  if (assertion !== undefined) {
    try {
      const user = claimsOf(await auth.onBehalfOf(assertion, signal));
      console.log(`on behalf of a user: issued`);
      console.log(`  for: ${shown(user.upn ?? user.unique_name ?? user.oid)}`);
      console.log(`  scopes: ${shown(user.scp ?? "none in the token")}`);
    } catch (e) {
      if (!(e instanceof GraphAuthError)) throw e;
      failed = true;
      console.log(
        `on behalf of a user: REFUSED (${e.subject === "user" ? "the person's token" : "the app"}). ${shown(e.message)}`,
      );
    }
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code; // not exit(): what was printed is written out first
  },
  (e: unknown) => {
    // Its message says what failed and holds no credential; a stack adds nothing for an admin.
    const message = isConnectorError(e) || e instanceof Error ? e.message : "failed";
    // Why a server couldn't be reached (ENOTFOUND, ECONNREFUSED, a certificate's fault).
    const inner = (e as { cause?: { cause?: unknown } }).cause?.cause as
      { code?: unknown; errors?: { code?: unknown }[] } | undefined;
    const code = inner?.code ?? inner?.errors?.[0]?.code;
    console.error(shown(typeof code === "string" ? `${message} (${code})` : message));
    process.exitCode = 1;
  },
);
