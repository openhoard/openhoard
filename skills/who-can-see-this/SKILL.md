---
name: who-can-see-this
description: Explain who can see one of the person's files in OpenHoard, and why a particular colleague can or can't open it ("who has access to the salary sheet?", "why can Bo see my draft?", "can the Finance group read this?"). Use when the owner of a file asks about its access, sharing or visibility.
---

# Who can see this

OpenHoard's `explain` tool answers access questions for **the file's owner** (admins use
OpenHoard's own app). It lists who has access through which grant, how visible the file is,
and, for a named person, whether they can read it and why.

## Steps

1. **Find the file** if you don't have its id: call `find` with the person's description and
   confirm the match with them.
2. Call `explain` with the file's `id`. If they asked about a specific colleague, pass that
   colleague's email as `person`.
3. **Answer in plain words:**
   - who has access: each person or group, `read` or `write`, and whether it is on the file
     itself or through a tag (e.g. "the Finance group, through the tag dept:finance");
   - how visible the file is (`visibility`: hidden, discoverable, readable) and how far AI
     apps may read it (`exposure`);
   - for a named person: `canRead`, what they see (`sees`: card, title-only, none) and the
     `explanation` sentence;
   - `pendingTagAccess`: grants that will count once someone reviews a model's tag.
     Mention the answer's `note`: pack rules can add or remove access beyond grants.
4. If `explain` refuses because the person doesn't own the file, say only the owner (or an
   admin, in OpenHoard) can see who has access, and name the owner if a card shows one.

## Limits

- This reads access; it doesn't change it. To share or unshare, send the person to OpenHoard
  (or the file's source, e.g. SharePoint). Never call `tag` to change access: tags that decide
  who can see a file are refused for assistants.
- It answers for now, not for the past ("could Bo see it last week?" is in the audit log).
