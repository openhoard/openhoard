import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeAcl, type AclEntry } from "@openhoard/sdk";
import type { ContractSource } from "@openhoard/sdk/testing";
import { fsConnector, type FsConnectorOptions } from "../fs-connector.js";

/* The contract kit's fixture for the fs connector, shared by this package's tests (not built). */

/** A temporary folder and the connector over it, changed as a person would change it. */
export async function fsSource(
  options: { checkpointEvery?: number; defaultAcl?: AclEntry[] } & Partial<FsConnectorOptions> = {},
): Promise<ContractSource & { root: string; stateDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "openhoard-fs-"));
  const root = join(base, "root");
  const stateDir = join(base, "state");
  await mkdir(root);
  const connector = fsConnector({
    root,
    stateDir,
    checkpointEvery: options.checkpointEvery ?? 5,
    chunkSize: options.chunkSize ?? 16 * 1024,
    ...(options.defaultAcl ? { defaultAcl: options.defaultAcl } : {}),
  });
  const at = (path: readonly string[]) => join(root, ...path);
  // Each write gets a later modification time than the last, a second apart: file systems with
  // coarse timestamps (FAT: 2 s, ext4's clock tick) must still see two writes as two versions.
  let clock = Math.floor(Date.now() / 1000) - 86_400;
  return {
    root,
    stateDir,
    connector,
    async mkdir(path) {
      await mkdir(at(path), { recursive: true });
    },
    async write(path, bytes) {
      await mkdir(dirname(at(path)), { recursive: true });
      await writeFile(at(path), bytes);
      clock += 2;
      await utimes(at(path), clock, clock);
    },
    async move(from, to) {
      await mkdir(dirname(at(to)), { recursive: true });
      await rename(at(from), at(to));
    },
    async remove(path) {
      await rm(at(path), { recursive: true });
    },
    async expectedAcl() {
      return options.defaultAcl
        ? { basis: "configured", entries: normalizeAcl(options.defaultAcl) }
        : { basis: "owner-only", entries: [] };
    },
    async close() {
      await rm(base, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
