/*
 * The few pages the server itself renders (T-105), until the web app (T-901): choosing how to sign
 * in, consenting to an MCP client, waiting for an admin, and errors. Plain HTML, everything
 * escaped, no scripts; the Content-Security-Policy allows only the inline style, and forms to
 * this server (and, for consent, the client's redirect, which the answer goes to).
 */

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fafaf7}
h1{font-size:1.4rem}code,.host{font-family:ui-monospace,monospace;background:#eee;padding:0 .25rem;border-radius:3px}
.warn{background:#fff3cd;border:1px solid #e0c060;padding:.5rem .75rem;border-radius:6px}
ul{padding-left:1.2rem}button,a.button{font:inherit;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer;text-decoration:none;color:inherit}
button.primary{background:#8a5a00;border-color:#8a5a00;color:#fff}
@media (prefers-color-scheme:dark){body{background:#17171a;color:#eee}code,.host{background:#333}button,a.button{background:#222;color:#eee}}`;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

export interface Page {
  html: string;
  csp: string;
}

function page(title: string, body: string, formTargets: readonly string[] = []): Page {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${escapeHtml(title)} · OpenHoard</title><style>${STYLE}</style></head><body>${body}</body></html>`;
  const forms = ["'self'", ...formTargets].join(" ");
  return {
    html,
    csp: `default-src 'none'; style-src 'unsafe-inline'; form-action ${forms}; frame-ancestors 'none'; base-uri 'none'`,
  };
}

export function signInPage(
  providers: readonly { id: string; label: string }[],
  returnTo: string,
  options: { links?: boolean } = {},
): Page {
  const links = providers
    .map(
      (p) =>
        `<li><a class="button" href="/auth/login/${encodeURIComponent(p.id)}?return_to=${encodeURIComponent(returnTo)}">${escapeHtml(p.label)}</a></li>`,
    )
    .join("");
  const viaLink = options.links
    ? `<p>${providers.length ? "Or sign" : "Sign"} in with a one-time link: run <code>openhoard admin user sign-in-link</code> on the server, open the link it prints in this browser, then reload this page.</p>`
    : "";
  return page(
    "Sign in",
    `<h1>Sign in to OpenHoard</h1>${providers.length ? `<ul>${links}</ul>` : options.links ? "" : "<p>No sign-in is configured.</p>"}${viaLink}`,
  );
}

/** A one-time sign-in link's page: a button, so opening (or prefetching) it uses nothing up. */
export function signInLinkPage(token: string): Page {
  return page(
    "Sign in",
    `<h1>Sign in to OpenHoard</h1>
<p>This link signs you in once, in this browser. Use it only if you asked for it.</p>
<form method="post" action="/auth/link">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button class="primary" type="submit">Sign in</button>
</form>`,
  );
}

/** After a sign-in link: where to go next. */
export function signedInPage(): Page {
  return page(
    "Signed in",
    `<h1>You're signed in</h1>
<p>Go back to the tab or app that asked you to sign in, and try again: an AI client connecting to OpenHoard asks for your consent next.</p>`,
  );
}

export interface ConsentView {
  clientName: string;
  clientRef: string;
  redirectUri: string;
  scopes: readonly string[];
  userName: string;
  request: string;
}

const SCOPE_TEXT: Record<string, string> = {
  "files:read": "find and read the files you can read, as you",
  "files:tag": "suggest tags on files you can tag (people review them)",
};

export function consentPage(v: ConsentView): Page {
  const redirect = new URL(v.redirectUri);
  const loopback = redirect.protocol === "http:";
  const scopes = v.scopes.map((s) => `<li>${escapeHtml(SCOPE_TEXT[s] ?? s)}</li>`).join("");
  const body = `<h1>Allow ${escapeHtml(v.clientName)} to use OpenHoard?</h1>
<p>Signed in as <strong>${escapeHtml(v.userName)}</strong>.</p>
<p>The client identifies as <span class="host">${escapeHtml(v.clientRef)}</span>, and the answer goes to <span class="host">${escapeHtml(redirect.host)}</span>.</p>
${loopback ? `<p class="warn">It answers to a program on this computer (<code>${escapeHtml(redirect.host)}</code>). Allow it only if you started it.</p>` : ""}
<p>It will be able to:</p><ul>${scopes}</ul>
<p>It sees nothing you can't, and your admin's rules still apply. You can revoke it at any time.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request" value="${escapeHtml(v.request)}">
<button class="primary" type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`;
  return page("Allow access", body, [redirect.origin]);
}

export function pendingPage(clientName: string, clientRef: string): Page {
  return page(
    "Waiting for approval",
    `<h1>${escapeHtml(clientName)} isn't approved yet</h1>
<p>Your admin has to approve <span class="host">${escapeHtml(clientRef)}</span> before it can connect to OpenHoard. Your request is recorded for them; try again once they have approved it.</p>`,
  );
}

export function errorPage(message: string): Page {
  return page(
    "Can't continue",
    `<h1>This request can't continue</h1><p>${escapeHtml(message)}</p>`,
  );
}
