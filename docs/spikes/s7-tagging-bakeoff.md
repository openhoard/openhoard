# Spike S7: tagging bake-off

- Task: T-026
- Time box: 3 days
- Result: **not run yet**. It needs a realistic labelled sample and model access.
- Confirms / changes: the enrichment design (model routing by exposure)

## Question

Which small model proposes tags that reviewers accept at least 85% of the time, and what does it cost per 1,000 versions?

## Pass criteria

- The winning model reaches at least 85% acceptance.
- Cost per 1,000 versions is recorded for every candidate.

## Why the fake tenant is not enough

The testkit's generated content is synthetic filler. Its labels are written into the text, which is ideal for leak and search tests but meaningless for judging a tagger. The bake-off needs about 500 realistic documents with human labels.

## Method (planned)

1. **Sample:** 500 documents across the planned facets (`type`, `client`, `project`, `sensitivity`, `department`), labelled by two people, with disagreements settled. Sources could be the maintainer's own non-sensitive files, or public-domain corpora with a compatible licence.
2. **Candidates (3–4):**
   - local models through Ollama or LM Studio (both are already on the maintainer's machine), for example a 3–8B instruction-tuned model;
   - one or two small hosted models.
   - Local models matter because `local-only` exposure forbids sending content to a commercial API.
3. **Harness:** the same prompt and output schema for every candidate, fed the extracted text (`extractText`) and the vocabulary. Validate proposals against the vocabulary, as the core does. Measure precision and recall per facet, "acceptance" (proposals a reviewer keeps), latency, and cost per 1,000 versions (tokens × price, or GPU time for local models).
4. **Safety:** run the injection corpus (T-017) through each candidate. Any proposal of a loosening tag is a failure, whatever the accuracy.

## Decision

Pending, until the sample and model access are ready.
