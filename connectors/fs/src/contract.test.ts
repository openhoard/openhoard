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

connectorContract("fs", { checkpointEvery: 5, manifest, open: () => fsSource() });

connectorContract("fs, with a default ACL", {
  checkpointEvery: 7,
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
