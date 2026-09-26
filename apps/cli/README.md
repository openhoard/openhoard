# openhoard (CLI)

Command-line tool for [OpenHoard](https://openhoard.com), the open-source AI filesystem.

Pre-alpha. Today it validates OpenHoard plugin manifests:

```bash
npx openhoard manifest validate path/to/openhoard.plugin.json
npx openhoard manifest schema
```

## Packaging

When the core packages are bundled into this CLI, `@openhoard/enricher-extract` stays outside
the bundle, an ordinary dependency installed as files: its extractor runs as a child process
from its own `dist/child.js`, allowed to read only its own folders and its libraries' (see
[enrichers/extract](../../enrichers/extract/README.md#the-sandbox)).

Source: https://github.com/openhoard/openhoard · License: Apache-2.0
