import { ConnectorError, isAbortError } from "@openhoard/sdk";
import type { GraphAuth } from "./auth.js";
import { objectOf, retryAfterMs } from "./http.js";

/*
 * Whether the app reaches the sites it is configured for (T-302). With `Sites.Selected` an app
 * has consent in Entra and still reaches nothing until an admin grants it each site: this asks
 * Graph for each one and says which answer came back, so a setup mistake reads as "this site
 * isn't granted" rather than as an empty crawl.
 */

export interface SiteProbe {
  /** The site as it was configured. */
  site: string;
  /**
   * - `ok`: the app reads the site;
   * - `denied`: Graph refused (the site isn't granted to the app, or the app lacks the permission);
   * - `not-found`: no such site.
   */
  status: "ok" | "denied" | "not-found";
  /** `ok`: the site's id as Graph gives it, its name and its address. */
  id?: string;
  name?: string;
  webUrl?: string;
}

/** A site's id (`host,guid,guid`), its host alone, or `root`: one path segment, never dots only. */
const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(,[A-Za-z0-9-]+,[A-Za-z0-9-]+)?$/;
/** Graph's own names under /sites, which are not sites. */
const NOT_SITES = new Set(["getallsites", "delta", "add", "remove"]);
/** A site's answer is a few hundred bytes. */
const MAX_SITE_BYTES = 64 * 1024;
const SITE_PATH = /^((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}):(\/(?!\/)[^?#\\]*)$/;

/**
 * The Graph path of a site named by its id (`contoso.sharepoint.com,<guid>,<guid>`) or by its
 * host and path (`contoso.sharepoint.com:/sites/finance`). Anything else is refused: the value
 * comes from configuration and goes into a URL.
 */
export function sitePath(site: string): string {
  const lower = site.toLowerCase();
  if (SITE_ID.test(site) && !NOT_SITES.has(lower) && !lower.startsWith("microsoft.graph.")) {
    return `/v1.0/sites/${site}`;
  }
  const plain = [...site].every((ch) => (ch.codePointAt(0) as number) >= 0x20 && ch !== "\u007f");
  const byPath = plain ? SITE_PATH.exec(site) : null;
  if (byPath) {
    const segments = (byPath[2] as string).split("/").filter((s) => s !== "");
    // Not "." or "..", and none of what a SharePoint name can't hold (a ":" would also end the
    // path, as in <site>:/drive).
    if (!segments.some((s) => s === "." || s === ".." || /[:%*<>|"]/.test(s))) {
      try {
        // The path as people read it, not yet encoded: "Team Finance", not "Team%20Finance".
        return `/v1.0/sites/${byPath[1]}:/${segments.map(encodeURIComponent).join("/")}`;
      } catch {
        // half a surrogate pair: not a name SharePoint has
      }
    }
  }
  throw new Error(
    `not a site: ${JSON.stringify(site.slice(0, 200))} (give its id, or <host>:/sites/<name> as contoso.sharepoint.com:/sites/finance)`,
  );
}

/**
 * Asks Graph for each site with the app's own token. One request a site, in turn. A failure
 * that isn't an answer about a site (Graph busy, the token refused) rejects the whole probe.
 */
export async function probeSites(
  auth: GraphAuth,
  sites: readonly string[],
  signal: AbortSignal,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<SiteProbe[]> {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const paths = sites.map(sitePath); // all checked before anything is asked
  const out: SiteProbe[] = [];
  for (const [i, site] of sites.entries()) {
    const url = `${auth.graph}${paths[i] as string}?$select=id,displayName,webUrl`;
    let token = await auth.appToken(signal);
    let response = await get(send, url, token, signal);
    if (response.status === 401) {
      // The token was refused though Entra issued it (revoked meanwhile): once more, anew.
      await response.body?.cancel().catch(() => undefined);
      auth.forget(token);
      token = await auth.appToken(signal);
      response = await get(send, url, token, signal);
    }
    if (response.ok) {
      let json: Record<string, unknown>;
      try {
        json = await objectOf(response, MAX_SITE_BYTES);
      } catch (e) {
        if (isAbortError(e, signal)) throw e;
        throw new ConnectorError("retryable", "Graph's answer was cut short", { cause: e });
      }
      // "OK" from something that isn't Graph (a proxy's page) is not a site reached.
      if (typeof json.id !== "string" || json.id === "") {
        throw new ConnectorError("retryable", "Graph's answer wasn't a site");
      }
      out.push({
        site,
        status: "ok",
        id: json.id,
        ...(typeof json.displayName === "string" ? { name: json.displayName } : {}),
        ...(typeof json.webUrl === "string" ? { webUrl: json.webUrl } : {}),
      });
      continue;
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 403) out.push({ site, status: "denied" });
    else if (response.status === 404) out.push({ site, status: "not-found" });
    else if (response.status === 401) {
      auth.forget(token);
      throw new ConnectorError("auth", "Graph refused the app's token");
    } else if (response.status === 429 || response.status === 503) {
      throw new ConnectorError("throttled", `Graph asked to slow down (${response.status})`, {
        retryAfterMs: retryAfterMs(response.headers.get("retry-after"), now()) ?? 30_000,
      });
    } else if (response.status >= 300 && response.status < 400) {
      throw new ConnectorError(
        "permanent",
        `Graph's address answered with a redirect (${response.status}): it isn't Graph`,
      );
    } else if (response.status >= 500) {
      throw new ConnectorError("retryable", `Graph is busy (${response.status})`);
    } else {
      throw new ConnectorError("permanent", `Graph refused the request (${response.status})`);
    }
  }
  return out;
}

async function get(
  send: typeof fetch,
  url: string,
  token: string,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await send(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      // The request holds a token: it goes to Graph or nowhere.
      redirect: "manual",
      signal,
    });
  } catch (e) {
    if (isAbortError(e, signal)) throw e;
    throw new ConnectorError("retryable", "Graph couldn't be reached", { cause: e });
  }
}
