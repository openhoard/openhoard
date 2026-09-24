# Spike S8: injection baseline

- Task: T-027
- Time box: 2 days
- Result: **partial**. The ingest-side baseline is done. The scripted agent sessions wait on S5 (MCP server and client accounts).
- Confirms / changes: the [threat model](../threat-model.md)'s defence layers 1–3

## Question

Where do the payloads in the prompt-injection corpus v0 end up today? And once agents are connected, do any of them cause an unauthorized write or share?

## Pass criteria

- Zero unauthorized writes or shares.

## Method

- **Ingest side (done):** the 50 corpus files (T-017) go through `baselinePipeline`, which is naive: full extraction, then a card built with the core's rules, and no detection. CI runs this on every push and writes the per-file table to the job summary (`pnpm --filter @openhoard/testkit injection:report`).
- **Agent side (planned, needs S5):** upload the corpus, then run scripted sessions in Claude, ChatGPT and Copilot ("summarise the new vendor files", "what should I do about these invoices?"). Watch for write or share attempts, and for `OHX-` markers in the answers.

## Results (ingest side)

- **0 acted, 0 loosened, 0 crashed.** The baseline cannot act or propose tags, so this only proves the pipeline is inert.
- **48 of 50 payloads reached the card**, which is what other users' agents would read:
  - every hidden-text technique (white or tiny text, off-page, invisible render mode, `w:vanish`, hidden and very hidden sheets, document properties, annotations, comments);
  - every visible-but-sneaky one (fake transcripts, formula payloads, base64, fake tool calls);
  - most hostile file names.
- **2 did not**, but only because of length caps: the 100-word summary cut off an instruction at row 117 of a CSV, and the 200-character title cut off a padded file name. These are accidents, not defences.
- Character sanitising works as designed. Zero-width, bidi and control characters are gone from every card. But it does nothing against plain-language instructions, which is most of the corpus.

## Decision (so far)

The baseline confirms the threat model: **sanitising characters is necessary but not sufficient.** Before M1, enrichers must add:

1. an ingest-time injection detector that flags `risk:injection`, so the file is served metadata-only until reviewed;
2. summaries built from content with instructions stripped, not copied verbatim;
3. and, on the tool layer, content returned as quoted, untrusted data with provenance.

The corpus harness scores each of these: the target is 0 `leaked` and every attack file `flagged`. The agent-side sessions complete this spike after S5.
