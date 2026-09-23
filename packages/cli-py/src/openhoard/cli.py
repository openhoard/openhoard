"""OpenHoard CLI. Today: validate plugin manifests against the v1 schema."""

from __future__ import annotations

import json
import sys
from importlib.resources import files
from typing import Iterable, List, Tuple

from jsonschema import Draft202012Validator

from . import __version__

SCHEMA = json.loads(
    files("openhoard").joinpath("schemas/plugin-manifest.v1.schema.json").read_text("utf-8")
)
_VALIDATOR = Draft202012Validator(SCHEMA)

USAGE = f"""openhoard {__version__}

Usage:
  openhoard --version
  openhoard manifest validate <file...>   Validate plugin manifest(s) against schema v1
  openhoard manifest schema               Print the v1 manifest JSON Schema
"""


def validate_manifest(manifest: object) -> Tuple[bool, List[str]]:
    errors = sorted(_VALIDATOR.iter_errors(manifest), key=lambda e: list(e.absolute_path))
    return (not errors, [_fmt(e) for e in errors])


def _fmt(err) -> str:
    where = "/" + "/".join(str(p) for p in err.absolute_path) if err.absolute_path else "(root)"
    return f"{where}: {err.message}"


def main(argv: Iterable[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    cmd, sub, rest = (args + [None, None])[0], (args + [None, None])[1], args[2:]
    if cmd in (None, "-h", "--help", "help"):
        print(USAGE, end="")
        return 0
    if cmd in ("-v", "--version", "version"):
        print(__version__)
        return 0
    if cmd == "manifest" and sub == "schema":
        print(json.dumps(SCHEMA, indent=2))
        return 0
    if cmd == "manifest" and sub == "validate":
        if not rest:
            print("error: give at least one manifest file", file=sys.stderr)
            return 2
        failed = 0
        for path in rest:
            try:
                with open(path, encoding="utf-8") as fh:
                    manifest = json.load(fh)
            except (OSError, json.JSONDecodeError) as exc:
                print(f"✗ {path}: cannot read JSON ({exc})", file=sys.stderr)
                failed += 1
                continue
            ok, errors = validate_manifest(manifest)
            if ok:
                print(f'✓ {path}: valid {manifest["type"]} "{manifest["name"]}"')
            else:
                failed += 1
                print(f"✗ {path}", file=sys.stderr)
                for e in errors:
                    print(f"    {e}", file=sys.stderr)
        return 1 if failed else 0
    print(f"error: unknown command\n\n{USAGE}", end="", file=sys.stderr)
    return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
