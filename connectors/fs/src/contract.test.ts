import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectorContract } from "@openhoard/sdk/testing";
import { fsSource } from "./testing/fixture.js";

/*
 * T-301's done-when: the fs connector passes the contract kit, on real temporary folders, with
 * and without a configured default ACL.
 */

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../openhoard.plugin.json", import.meta.url)), "utf8"),
) as unknown;

/*
 * Windows runners in CI stall on file system calls (the same test took 0.1 s in one suite below
 * and 26 s in the other), so a test there gets longer before it counts as hung. The fixture never
 * waits: its later modification times are set with utimes(), not slept for.
 */
const timeoutMs = process.platform === "win32" ? 120_000 : 30_000;

connectorContract("fs", { checkpointEvery: 5, manifest, timeoutMs, open: () => fsSource() });

connectorContract("fs, with a default ACL", {
  checkpointEvery: 7,
  timeoutMs,
  open: () =>
    fsSource({
      checkpointEvery: 7,
      defaultAcl: [
        { principal: { kind: "group", id: "all-staff" }, role: "read", inherited: true },
        {
          principal: { kind: "user", id: "owner-1", email: "Ann@Example.com" },
          role: "owner",
          inherited: true,
        },
      ],
    }),
});
