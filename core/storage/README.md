# core/storage

Part of the OpenHoard trusted core. See [../README.md](../README.md),
[ADR-0006](../../docs/adr/0006-storage-abstraction.md) and
[ADR-0013](../../docs/adr/0013-content-hash.md).

Content-addressed blob storage on local disk, S3 or Azure Blob, through
[Apache OpenDAL](https://opendal.apache.org/) (native binaries for Windows, macOS and Linux).

```ts
import { BlobStore } from "@openhoard/core-storage";

const blobs = BlobStore.open({ kind: "fs", root: ".openhoard/blobs" });
const { blobId, created } = await blobs.put({ id: tenantId, key: tenantBlobKey }, fileStream);
const stream = await blobs.open(tenantId, blobId, { offset: 0, length: 1024 });
```

## Ids and layout

- A blob's id is `b3t:<hex>`: a BLAKE3 hash of the content's BLAKE3 hash, keyed with the
  tenant's 32-byte secret (`scopedBlobId` in core/catalog).
  - Identical bytes in one tenant are stored once; `put()` reports `created: false`.
  - Identical bytes in two tenants get unrelated ids. Neither storage paths nor
    de-duplication reveal that another tenant holds the same file.
  - The raw content hash is never stored or used as a path.
- Paths are `<tenant>/<hex[0:2]>/<hex[2:4]>/<hex>`. Every path is built from a validated
  tenant id and a validated blob id, so a malformed id cannot reach outside its tenant.
- Every upload, streamed or not, is written to `<tenant>/.incoming/<uuid>` while it is
  hashed, and moves to its final path only when it is complete. So a blob id never names
  partial bytes.
  - The move is a rename where the service has one, which is atomic.
  - Otherwise it is a copy, checked before the upload is deleted.
  - Otherwise it is a streamed copy, which removes what it wrote if it fails.
- A failed upload removes its incoming file. `sweepIncoming()` clears what a crashed
  process left behind, as far as the service lists it:
  - On S3, a large upload is a multipart upload, and one a crash interrupts is not an object:
    listing doesn't show it, so `sweepIncoming()` can't remove it, and its parts are billed
    until aborted. Give the bucket a lifecycle rule with `AbortIncompleteMultipartUpload`
    (for example after 1 day).
  - On Azure Blob, uncommitted blocks aren't listed either; Azure discards them after 7 days.
- On local disk, writes aren't fsynced before the rename. After a power loss a blob can be
  torn (its final path holding short or zeroed bytes); `verify()` detects that, since the
  bytes no longer match the id.
- An existing blob of the wrong size is replaced rather than trusted.

## Reading

- `open()` streams a blob or a byte range; ranges are read in 4 MiB requests.
- `read()` loads a small blob or range into memory.
- `verify()` re-hashes a blob and reports whether it still matches its id.

## Enrichment

`blobContentSource(store)` is how enrichment reads the bytes OpenHoard holds (core/catalog
`ContentSource`, T-402): a version whose blob has a location streams from the store by its
content-addressed id; one without (an indexed zone) is left to a connector's source (null). A
blob the catalog says is stored but the store doesn't have throws, so the job retries and then
dead-letters for an operator instead of treating the content as absent.

## Limits

- S3's CopyObject handles up to 5 GiB, so on S3 a single upload larger than that fails at
  the move. Large-file exchange (M3) needs a multipart path.
- Deleting a blob is the catalog's job: it must delete only blobs no version references,
  under the same lock as new references. A `put()` that races a `delete()` of the same
  bytes can report `created: false` for a blob that is then removed.

## Tests

The suite runs on local disk and in memory on every PR. The memory service has neither
rename nor copy, which covers the streaming fallback. To run the same suite on real
services, set:

- S3: `OPENHOARD_TEST_S3_BUCKET` and optionally `OPENHOARD_TEST_S3_REGION`. Credentials
  come from the usual AWS environment variables.
- Azure Blob: `OPENHOARD_TEST_AZBLOB_CONTAINER`, `OPENHOARD_TEST_AZBLOB_ACCOUNT` and
  `OPENHOARD_TEST_AZBLOB_KEY`.
