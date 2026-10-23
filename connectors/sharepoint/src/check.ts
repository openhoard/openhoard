#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isConnectorError } from "@openhoard/sdk";
import { graphAuth, type ClientCredential } from "./auth.js";
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
 *   OPENHOARD_GRAPH_AUTHORITY, OPENHOARD_GRAPH_URL   optional: a national cloud's addresses
 *
 * It gets an app-only token, asks Graph for each site, and says what came back; with a
 * certificate, it also asks SharePoint's own API for each site's groups (who is in them is
 * what makes a file shared with "Members" shared with its members). It prints no
 * token and no secret. Exit status: 0 when every site is reached, 1 otherwise, 2 for a mistake
 * in how it was run (an argument, a variable, a file).
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

  /** Whether SharePoint says who is in the site's groups, as the connector will ask it. */
  async function siteGroupsOf(webUrl: string | undefined): Promise<string> {
    if (credential.kind !== "certificate") {
      return "not readable with a client secret (SharePoint takes a certificate): files shared through the site's groups will be shared with nobody";
    }
    if (webUrl === undefined || !webUrl.startsWith("https://")) return "no site address to ask";
    const origin = new URL(webUrl).origin;
    let token: string;
    try {
      token = await auth.appToken(signal, origin);
    } catch (e) {
      failed = true;
      return `REFUSED by Entra for SharePoint: ${shown((e as Error).message)}`;
    }
    const response = await fetch(
      `${webUrl.replace(/\/$/, "")}/_api/web/sitegroups?$select=Id&$top=1`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json;odata=nometadata",
        },
        redirect: "manual",
        signal,
      },
    );
    await response.body?.cancel();
    if (response.ok) return "readable";
    failed = true;
    return `REFUSED (${response.status}). Give the app SharePoint's Sites.Selected application permission too (SharePoint, not Graph, in API permissions), with admin consent.`;
  }

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
      console.log(`  site groups: ${await siteGroupsOf(probe.webUrl)}`);
    } else {
      failed = true;
      console.log(
        probe.status === "denied"
          ? `site ${probe.site}: REFUSED. The app isn't granted this site (Sites.Selected is granted site by site), or lacks the permission.`
          : `site ${probe.site}: NOT FOUND. Check the host and path, or the id.`,
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
