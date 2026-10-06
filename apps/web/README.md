# apps/web

OpenHoard's admin web app (T-901): React, built by Vite to static files that `apps/server`
serves at `/admin/` (see "The admin web app" in [apps/server/README.md](../server/README.md)).

It has the shell (who is signed in, the way around, the way out) and four pages: an overview of
the tenant's sources, the tags AI suggested that wait for a person, the AI clients its people
may connect, and the vocabulary. Pages for the audit log and the File Health Report are added
to it.

## How it is put together

- **It holds nothing.** Every page asks the server as the signed-in person (`src/api.ts`:
  `/auth/me`, `/api/admin/*`, with the session cookie) and shows the answer. Who may see what is
  the server's decision on every request, never the app's.
- **Signing in is the server's** (`/auth/sign-in`): the app sends whoever isn't signed in there
  and comes back to the page they asked for. If they come back still signed out, it stops and
  says so instead of going round.
- **Pages are paths** under `/admin/` (`src/router.tsx`), with the browser's own history, so a
  link can be copied or opened in a new tab.
- **Words for an admin** live in `src/words.ts`, apart from the markup, and are tested as text.
- **Nothing inline, nothing from elsewhere.** The server's Content-Security-Policy allows this
  origin's own files only. So: styles in `src/theme.css` (no `style` attributes in markup the
  server sends), no web fonts, no images as `data:` URLs (`assetsInlineLimit: 0`), no analytics.
- **Few dependencies**: React and Vite. No router, state or component library until a page needs
  one.

## Working on it

```
pnpm --filter @openhoard/web build        # dist/, which the server serves
pnpm --filter @openhoard/web test         # the app in a DOM (jsdom)
pnpm --filter @openhoard/web dev          # with reloads, at http://127.0.0.1:5173/admin/
```

`dev` sends `/auth` and `/api` to a server on this machine (`OPENHOARD_DEV_SERVER`,
`http://127.0.0.1:7420` by default). Sign in at that server first (in the same browser): cookies
are the host's, whatever the port, so the dev page is signed in too. Anything that changes
something (Sign out, a decision on an AI client) is refused there by the server's Origin check,
and shows as a failure or "not allowed": use the built app for those.

## Browsers

Current Chrome, Edge, Safari and Firefox. The tests run in jsdom, which is none of them: a
change to the shell is checked in each by hand until a browser run is set up.
