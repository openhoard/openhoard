# OpenHoard browser extension (T-1207)

Saves what you are looking at to **your own** OpenHoard server: the page, a PDF, or a selection.
Manifest V3, one build for Chrome, Edge and Firefox. It talks to the server you name and to
nothing else.

## What it saves

| You are on  | Saved as                                                              |
| ----------- | --------------------------------------------------------------------- |
| A web page  | Its readable text as Markdown (`<title>.md`), with the page's address |
| A PDF       | The PDF itself, with its address                                      |
| A selection | The selected text as Markdown, named with the time                    |

- From the toolbar button, or from the page's menu (right-click): "Save page to OpenHoard",
  "Save selection to OpenHoard".
- **A page is saved as text, not as a copy of the page.** OpenHoard's extractor reads text,
  Markdown, PDFs and office files; a page's HTML is mostly what a reader never sees. The main
  part of the page is taken (`article`, `main`), with headings, lists, quotes, code, tables and
  links. Scripts, forms, navigation, comments and hidden elements are left out, in a selection
  too. Hidden text is where instructions for an AI get planted; this drops the plain cases
  (`hidden`, `aria-hidden`, `display: none`, `visibility: hidden`), not every trick (text moved
  off-screen, made tiny or transparent, an image's description), and OpenHoard treats what it
  stores as untrusted either way.
- The address (without its `#fragment`) is kept with the file: OpenHoard's own page links back to it, and the MCP
  `describe` tool answers with it (`sourceUrl`), so an assistant can send you to the original.
- Saving the same page again makes a **new version** of the same file. A selection is always a
  new file.
- Files are yours alone until you share them, like any upload (apps/server README, "Adding
  files").

## Connecting

1. The server needs `"uploads": {}` in its config, and an address the browser can reach:
   https, or `http://localhost` / `http://127.0.0.1` for a server on the same machine.
2. Open the extension's options (it opens by itself from the toolbar button's "Set up"), type
   the server's address, and Connect. The browser asks whether the extension may reach that
   address.
3. A window opens on your server. You sign in. The first time, an admin of the server approves
   the extension on that page (it is an OAuth client like any other; "Consumer" is enough, it
   reads nothing). Then you allow it to add files as you.

The extension holds an access token and a refresh token for the `files:add` scope, in its own
storage. It can add files as you; it can't search, read or open anything. Disconnect (in the
options) forgets them and tells the server. An admin can revoke the client, and you can end
the grant, on the server.

What the server's admin approves is "the client whose answers go to this address": the
browser's redirect address for the extension, which comes from its id. A store build has one id
for everyone, so one approval per server covers its people; an unpacked build has a different
id on each machine, and each is approved once.

## Permissions

| Permission               | Why                                                                 |
| ------------------------ | ------------------------------------------------------------------- |
| `activeTab`, `scripting` | Read the tab you ask it to save, when you ask, and no other         |
| `contextMenus`           | The two entries in the page's menu                                  |
| `storage`                | The server's address and the tokens                                 |
| `identity`               | The sign-in window (the browser's own, for OAuth)                   |
| Your server's address    | Asked for when you connect: the only host it has standing access to |

A PDF is fetched again by the extension, as you (your cookies for that site), since the
browser's PDF viewer can't be read by extensions.

## Build and load

```sh
pnpm --filter @openhoard/extension build     # → clients/extension/dist
```

- **Chrome, Edge:** `chrome://extensions` (or `edge://extensions`), Developer mode, Load
  unpacked, choose `clients/extension/dist`.
- **Firefox (128 or later):** `about:debugging#/runtime/this-firefox`, Load Temporary Add-on,
  choose `dist/manifest.json`.

Store listings come with T-1210.

## Code

| File                | What                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| `src/lib.ts`        | The OAuth client (registration, PKCE, tokens) and the upload; no browser API in it |
| `src/capture.ts`    | Page → Markdown; one self-contained function, run inside the page                  |
| `src/background.ts` | The worker: saves the tab from the popup or the menu                               |
| `src/options.ts`    | Connect and disconnect (a page, so it outlives the sign-in window)                 |
| `src/popup.ts`      | The toolbar popup                                                                  |
| `src/env.ts`        | The browser's side of `lib.ts`                                                     |
| `src/browser.d.ts`  | The part of the WebExtensions API used, typed here (no types package)              |

`lib.ts` and `capture.ts` are unit-tested (`pnpm --filter @openhoard/extension test`); the rest
is glue that only runs in a browser.

## Not there yet

- Tested in Chromium only. Firefox loads the same build in principle (one manifest carries
  both browsers' background keys); it hasn't been run there.
- No full-page archive (HTML, images, a screenshot): text only.
- Pages inside frames aren't read, and a selection inside a frame isn't found; only the top
  document. Shadow DOM isn't read either.
- A PDF is held in memory on its way (100 MB at most), and a very slow one may be cut off by
  the browser's limit on a worker's request.
- A PDF behind a login that needs more than cookies (a one-time link) may not fetch again.
