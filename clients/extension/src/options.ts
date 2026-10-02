import { browserEnv } from "./env.js";
import { connect, disconnect, SaveError, serverOrigin } from "./lib.js";

/*
 * The options page: connects the extension to the person's server, and disconnects it. A page
 * (not the popup, not the worker), so it is still there when the sign-in window comes back.
 */

const env = browserEnv();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const input = $<HTMLInputElement>("server");
const connectButton = $<HTMLButtonElement>("connect");

function show(server: string | null): void {
  $("setup").hidden = server !== null;
  $("ready").hidden = server === null;
  if (server !== null) $("where").textContent = server;
}

connectButton.addEventListener("click", () => {
  let server: string;
  try {
    server = serverOrigin(input.value);
  } catch (e) {
    status.textContent = (e as Error).message;
    return;
  }
  connectButton.disabled = true;
  status.textContent = "Waiting for you to sign in and allow it…";
  // Asked for in the click itself: the browser lets the extension reach that one server.
  // (A match pattern names a host, never a port.)
  const { protocol, hostname } = new URL(server);
  chrome.permissions
    .request({ origins: [`${protocol}//${hostname}/*`] })
    .then((granted) => {
      if (!granted) throw new SaveError("refused", "The extension needs to reach your server.");
      return connect(env, server);
    })
    .then(
      (connection) => {
        status.textContent = "Connected. You can close this tab.";
        show(connection.server);
      },
      (e: unknown) => {
        status.textContent = e instanceof SaveError ? e.message : "Something went wrong.";
      },
    )
    .finally(() => {
      connectButton.disabled = false;
    });
});

$("disconnect").addEventListener("click", () => {
  void disconnect(env).then(() => {
    status.textContent = "Disconnected.";
    show(null);
  });
});

void env.load().then((c) => show(c?.server ?? null));
