# openhoard (CLI)

Command-line tool for [OpenHoard](https://openhoard.com), the open-source AI filesystem.

Pre-alpha. One `openhoard` command runs the server and its operator commands (T-1407), and
validates plugin manifests. From a clone, after `pnpm build`, it is `node apps/cli/dist/bin.js`:

```bash
openhoard [--data-dir <dir>] serve        # the server (@openhoard/server)
openhoard [--data-dir <dir>] admin …      # admin commands (apps/server README, "Admin CLI")
openhoard [--data-dir <dir>] init --solo  # a one-person setup (docs/dogfood.md)
openhoard [--data-dir <dir>] connect claude-desktop
openhoard [--data-dir <dir>] tunnel       # the server behind a Cloudflare tunnel
openhoard manifest validate path/to/openhoard.plugin.json
openhoard manifest schema
```

The server's own entry point (`apps/server/dist/main.js`) only serves; given a command, it says
which `openhoard` command to run instead. The server's package is loaded only for its commands,
so `manifest` stays light.

Not publishable to npm as it is: it depends on the workspace's private packages until they are
bundled into it (see Packaging).

## Packaging

When the core packages are bundled into this CLI, `@openhoard/enricher-extract` stays outside
the bundle, an ordinary dependency installed as files: its extractor runs as a child process
from its own `dist/child.js`, allowed to read only its own folders and its libraries' (see
[enrichers/extract](../../enrichers/extract/README.md#the-sandbox)).

Source: https://github.com/openhoard/openhoard · License: Apache-2.0
