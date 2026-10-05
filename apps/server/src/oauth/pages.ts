/*
 * The few pages the server itself renders (T-105), until the web app (T-901): choosing how to sign
 * in, consenting to an MCP client, waiting for an admin, and errors. Plain HTML, everything
 * escaped; the Content-Security-Policy allows only the inline style, and forms to this server
 * (and, for consent, the client's redirect, which the answer goes to). No scripts, except on the
 * two pages that run a passkey ceremony (T-108), which load this server's own `/auth/passkey.js`
 * and nothing else.
 */

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fafaf7}
h1{font-size:1.4rem}code,.host{font-family:ui-monospace,monospace;background:#eee;padding:0 .25rem;border-radius:3px}
.warn{background:#fff3cd;border:1px solid #e0c060;padding:.5rem .75rem;border-radius:6px}
ul{padding-left:1.2rem}label{display:block;margin:.4rem 0}button,a.button{font:inherit;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer;text-decoration:none;color:inherit}
button.primary{background:#8a5a00;border-color:#8a5a00;color:#fff}
@media (prefers-color-scheme:dark){body{background:#17171a;color:#eee}code,.host{background:#333}button,a.button{background:#222;color:#eee}}`;

/** A trust label in an admin's words (apps/web/src/words.ts TRUST_WORDS has the same). */
const TRUST_LABELS: Record<string, string> = {
  local: "Stays on our computers",
  commercial: "Organization AI",
  consumer: "Personal AI",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

export interface Page {
  html: string;
  csp: string;
}

function page(
  title: string,
  body: string,
  formTargets: readonly string[] = [],
  options: { passkeys?: boolean } = {},
): Page {
  // The one script there is: the passkey ceremonies, served by this server (passkeys.ts).
  const script = options.passkeys ? `<script src="/auth/passkey.js" defer></script>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${escapeHtml(title)} · OpenHoard</title><style>${STYLE}</style>${script}</head><body>${body}</body></html>`;
  const forms = ["'self'", ...formTargets].join(" ");
  const scripts = options.passkeys ? " script-src 'self'; connect-src 'self';" : "";
  return {
    html,
    csp: `default-src 'none'; style-src 'unsafe-inline';${scripts} form-action ${forms}; frame-ancestors 'none'; base-uri 'none'`,
  };
}

export function signInPage(
  providers: readonly { id: string; label: string }[],
  returnTo: string,
  options: { links?: boolean; passkeys?: boolean } = {},
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
  const viaPasskey = options.passkeys
    ? `<p><button class="primary" type="button" id="oh-passkey" data-mode="sign-in" data-return="${escapeHtml(returnTo)}">Sign in with a passkey</button></p>
<p id="oh-status" role="status"></p>
<noscript><p class="warn">Signing in with a passkey needs JavaScript.</p></noscript>`
    : "";
  const nothing = providers.length || options.links || options.passkeys;
  return page(
    "Sign in",
    `<h1>Sign in to OpenHoard</h1>${viaPasskey}${providers.length ? `<ul>${links}</ul>` : nothing ? "" : "<p>No sign-in is configured.</p>"}${viaLink}`,
    [],
    options.passkeys ? { passkeys: true } : {},
  );
}

/**
 * An invite's page (T-108): a button that makes a passkey for the invited person. The invite's
 * token is in the link's fragment, which the script reads; the page itself is the same for
 * everyone, so opening (or prefetching) it uses nothing up.
 */
export function invitePage(): Page {
  return page(
    "Set up your passkey",
    `<h1>Set up your passkey</h1>
<p>You were invited to OpenHoard. A passkey is how you sign in: your device keeps it, and unlocks it with your fingerprint, face or PIN. There is no password.</p>
<p><button class="primary" type="button" id="oh-passkey" data-mode="invite">Create a passkey</button></p>
<p id="oh-status" role="status"></p>
<noscript><p class="warn">Creating a passkey needs JavaScript.</p></noscript>`,
    [],
    { passkeys: true },
  );
}

/**
 * What the two passkey pages run: the WebAuthn ceremony between this server and the browser's
 * authenticator. Plain JavaScript with no dependencies, served as `/auth/passkey.js`. It talks to
 * this origin only, puts only fixed text on the page, and takes an invite's token out of the
 * address bar as soon as it has read it.
 */
export const PASSKEY_SCRIPT = `(() => {
  "use strict";
  const button = document.getElementById("oh-passkey");
  const status = document.getElementById("oh-status");
  if (!button || !status) return;
  const say = (text) => { status.textContent = text; };
  const encode = (buffer) => {
    let text = "";
    for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte);
    return btoa(text).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  };
  const decode = (text) => {
    const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  };
  const post = async (path, body) => {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error("refused"), { reason: data.reason, status: res.status });
    return data;
  };
  const REASONS = {
    used: "This invite was used already. If that was you, sign in with your passkey; if not, ask your admin for a new invite.",
    expired: "This invite has expired. Ask your admin for a new one.",
    revoked: "This invite was replaced or withdrawn. Ask your admin for a new one.",
    inactive: "This account can't sign in. Ask your admin.",
  };
  const explain = (err, fallback) => {
    if (err && err.name === "NotAllowedError") return "Cancelled, or it took too long. Try again.";
    if (err && err.name === "InvalidStateError") return "This device already has a passkey for your account. Sign in with it.";
    if (err && err.name === "SecurityError") return "This page isn't on the address OpenHoard is set up for, so passkeys can't be used here.";
    return (err && REASONS[err.reason]) || fallback;
  };
  if (!window.PublicKeyCredential || !navigator.credentials) {
    button.disabled = true;
    say("This browser doesn't support passkeys. Use a current browser.");
    return;
  }

  async function invite(token) {
    const options = await post("/auth/passkey/register/options", { invite: token });
    const credential = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: decode(options.challenge),
        user: { ...options.user, id: decode(options.user.id) },
        excludeCredentials: options.excludeCredentials.map((c) => ({ ...c, id: decode(c.id) })),
      },
    });
    const r = credential.response;
    await post("/auth/passkey/register", {
      invite: token,
      response: {
        id: credential.id,
        type: credential.type,
        response: {
          clientDataJSON: encode(r.clientDataJSON),
          attestationObject: encode(r.attestationObject),
          transports: typeof r.getTransports === "function" ? r.getTransports() : [],
        },
      },
    });
  }

  async function signIn(returnTo) {
    const options = await post("/auth/passkey/options", {});
    const credential = await navigator.credentials.get({
      publicKey: { ...options, challenge: decode(options.challenge) },
    });
    const r = credential.response;
    const done = await post("/auth/passkey", {
      return_to: returnTo,
      response: {
        id: credential.id,
        type: credential.type,
        response: {
          clientDataJSON: encode(r.clientDataJSON),
          authenticatorData: encode(r.authenticatorData),
          signature: encode(r.signature),
          userHandle: r.userHandle ? encode(r.userHandle) : null,
        },
      },
    });
    location.assign(done.returnTo || "/");
  }

  if (button.dataset.mode === "invite") {
    // The token never goes to a server in a URL: out of the address bar and the history now.
    const token = location.hash.slice(1);
    history.replaceState(null, "", location.pathname);
    if (!token) {
      button.disabled = true;
      say("This page needs an invite link. Open the link you were sent, whole.");
      return;
    }
    button.addEventListener("click", async () => {
      button.disabled = true;
      say("Follow your device's prompts...");
      try {
        await invite(token);
        button.hidden = true;
        say("Your passkey is ready, and you're signed in. Go back to the app that asked you to sign in, and try again.");
      } catch (err) {
        button.disabled = false;
        say(explain(err, "That didn't work. Try again, or ask your admin for a new invite."));
      }
    });
  } else {
    button.addEventListener("click", async () => {
      button.disabled = true;
      say("Follow your device's prompts...");
      try {
        await signIn(button.dataset.return || "/");
      } catch (err) {
        button.disabled = false;
        say(explain(err, "That passkey didn't sign you in."));
      }
    });
  }
})();
`;

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
  "files:add":
    "add files to OpenHoard as you, and new versions of the pages it saved (it can't read what is there)",
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

/**
 * A client no admin has approved yet. Someone who is an admin gets to decide here (`approval`:
 * the sealed request the form carries back, where the client's answers go, and whether an admin
 * refused it before); anyone else is told to wait.
 */
export function pendingPage(
  clientName: string,
  clientRef: string,
  approval?: {
    request: string;
    redirectUris: readonly string[];
    /** `refused`: an admin refused it before. `approved`: the config approved it once. */
    status: "pending" | "refused" | "approved";
    /** The label the server's config gives it: approving lifts a refusal, with that label. */
    configTrust?: string;
  },
): Page {
  if (!approval) {
    return page(
      "Waiting for approval",
      `<h1>${escapeHtml(clientName)} isn't approved yet</h1>
<p>Your admin has to approve <span class="host">${escapeHtml(clientRef)}</span> before it can connect to OpenHoard. Your request is recorded for them; try again once they have approved it.</p>`,
    );
  }
  const uris = approval.redirectUris
    .map((u) => `<li><span class="host">${escapeHtml(u)}</span></li>`)
    .join("");
  const loopback = approval.redirectUris.some((u) => new URL(u).protocol === "http:");
  const refused = approval.status === "refused";
  const why = refused
    ? " again: an admin refused this client before"
    : approval.status === "approved"
      ? " again: the server's config approved this client once, and no longer lists it"
      : "";
  const labels =
    approval.configTrust === undefined
      ? // The same three kinds, in the same words, as the admin web app's AI clients page
        // (apps/web/src/words.ts TRUST_WORDS): change both together.
        `<p>To approve, say what kind of app it is. That decides which files' content it is given:</p>
<label><input type="radio" name="trust" value="consumer"> <strong>Personal AI.</strong> An AI app on personal or free terms, including paid personal plans. Gets the content only of files cleared for any AI.</label>
<label><input type="radio" name="trust" value="commercial"> <strong>Organization AI.</strong> An AI service your organization has a business agreement with. Gets everything except files marked &ldquo;our computers only&rdquo;.</label>
<label><input type="radio" name="trust" value="local"> <strong>Stays on our computers.</strong> The AI runs on your own machines; nothing leaves them. A desktop app that uses a cloud AI doesn't count.</label>`
      : `<p>The server's config approves it, as <strong>${escapeHtml(TRUST_LABELS[approval.configTrust] ?? approval.configTrust)}</strong>. Approving lifts the refusal, with that label.</p>`;
  return page(
    "Approve this client?",
    `<h1>${escapeHtml(clientName)} ${refused ? "was refused" : "isn't approved yet"}</h1>
<p>You administer this OpenHoard, so this is yours to decide${why}. The client identifies as <span class="host">${escapeHtml(clientRef)}</span>, and its answers go to:</p>
<ul>${uris}</ul>
${loopback ? `<p class="warn">It answers to a program on the computer of whoever connects it. Approve it only if that is what you expect.</p>` : ""}
<p class="warn">The name is what the client calls itself, and anyone can send you a link to this page. Approve it only if you just started connecting that app yourself; otherwise refuse.</p>
<p>Approving lets people here connect it. Each of them still gives their own consent, and it sees nothing they can't. You can revoke it later.</p>
<form method="post" action="/oauth/approve">
<input type="hidden" name="request" value="${escapeHtml(approval.request)}">
${labels}
<p>${approval.status === "pending" ? `<button type="submit" name="decision" value="refuse">Refuse</button>\n` : ""}<button type="submit" name="decision" value="approve">Approve</button></p>
</form>`,
  );
}

export function errorPage(message: string): Page {
  return page(
    "Can't continue",
    `<h1>This request can't continue</h1><p>${escapeHtml(message)}</p>`,
  );
}
