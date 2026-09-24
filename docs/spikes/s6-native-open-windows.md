# Spike S6: native open on Windows

- Task: T-025
- Time box: 2 days
- Result: **not run yet**. It needs the local agent and a person at a Windows machine with Excel.
- Confirms / changes: FR-20 (`open(mode=native)`)

## Question

Can OpenHoard open a file in its desktop app on Windows? There are two cases:

1. **SharePoint-backed files:** Excel opens with co-authoring through an `ms-excel:` link.
2. **Bucket-backed files:** a downloaded copy opens in Excel, and saving it creates a new version.

## Pass criteria

- Excel opens with co-authoring for a SharePoint file.
- Saving a bucket-backed file in Excel creates a new version in OpenHoard.

## Environment check (done)

On the maintainer's Windows machine:

- the `ms-excel:`, `ms-word:` and `ms-powerpoint:` protocol handlers are registered;
- Microsoft 365 Apps (Click-to-Run 16.0.20326, x64) is installed.

This was a read-only registry check; nothing was launched.

## Method (planned)

1. **SharePoint files:** build `ms-excel:ofe|u|<https URL of the item>` (Office URI scheme, "open for edit") from the item's `webUrl`. Launch it with `start "" "<uri>"` from the local agent. Confirm that Excel opens the cloud copy, co-authoring is active, and edits land in SharePoint versions.
2. **Bucket files:**
   - the local agent downloads the version to a per-user cache and opens it with the default app;
   - it watches for writes (debounced; Excel saves through a temporary file and a rename);
   - it uploads a new version with the base version as a precondition, so a conflict is detected rather than overwritten.
   - Confirm the new version and its audit event.
3. **Edge cases:** the file is already open, there is a lock file (`~$name.xlsx`), Excel is closed without saving, the machine goes offline mid-save, and a long path.

## Decision

Pending. It needs the local agent (M2). The protocol handlers are present on the target machine.
