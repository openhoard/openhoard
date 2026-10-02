import type { Connection, Env } from "./lib.js";

/* The browser's side of lib.ts's Env: storage, the sign-in window, randomness, the clock. */

const KEY = "connection";

export function browserEnv(): Env {
  return {
    fetch: (input, init) => fetch(input, init),
    async load() {
      const kept = (await chrome.storage.local.get(KEY))[KEY];
      return typeof kept === "object" && kept !== null ? (kept as Connection) : null;
    },
    async store(connection) {
      if (connection === null) await chrome.storage.local.remove(KEY);
      else await chrome.storage.local.set({ [KEY]: connection });
    },
    redirectUri: chrome.identity.getRedirectURL(),
    async authorize(url) {
      const ended = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
      if (!ended) throw new Error("the sign-in window was closed");
      return ended;
    },
    random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
    sha256: async (data) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>)),
    now: () => Date.now(),
  };
}
