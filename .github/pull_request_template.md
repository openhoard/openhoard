## What and why

<!-- One or two sentences. Link the task (T-xxx) or issue. -->

## Definition of done

- [ ] Types strict, lint clean, formatted
- [ ] Tests added; coverage at or above the floor (core 85%, plugins 70%)
- [ ] Contract tests pass for any interface touched (schemas, SDK, MCP tool shapes)
- [ ] Touches identity, policy, catalog filtering, audit or sandbox → core review requested
- [ ] Reads file content or calls a model → prompt-injection suite passes
- [ ] Docs updated (ADR/RFC if a decision or contract changed)
- [ ] Changeset added for published packages (`pnpm changeset`)
- [ ] Every commit signed off (`git commit -s`)

## Security notes

<!-- Permissions, exposure, injection, audit impact. "None" is a fine answer. -->
