# @openhoard/connector-fs

A local folder, indexed in place (an Indexed zone), on Windows, macOS and Linux. It implements
connector interface v1 ([@openhoard/sdk](../../packages/sdk/README.md)) and passes the contract
kit.

```ts
import { fsConnector } from "@openhoard/connector-fs";

const connector = fsConnector({
  root: "/srv/shares/finance", // absolute
  stateDir: "/var/lib/openhoard/connectors/fs-finance", // absolute, outside the root
  defaultAcl: [{ principal: { kind: "group", id: "finance" }, role: "read", inherited: true }],
});
```

## How it works

- **crawl()** walks the folder depth first, parents before their children, names in UTF-16
  code-unit order (the same on every OS, whatever order the file system lists them in). Every
  item it yields goes to a journal in `stateDir`; a checkpoint (every `checkpointEvery` items,
  default 500) names the journal's length, so a killed crawl resumes right after it and its
  cursor still covers what it yielded before.
- **delta()** walks again and compares with the snapshot its cursor names (kept in `stateDir`,
  named by its hash): new, changed, renamed, moved and deleted items, deletes first. It writes
  the new snapshot before yielding, and checkpoints every `checkpointEvery` changes (naming both
  snapshots and how far it got), so a long delta can stop and resume without walking again (a
  resumed delta reports the first attempt's warnings again). No
  file system watcher: comparing can't miss what happened while nothing was watching. Tokens
  stay small however large the folder; losing `stateDir` means a `resync` (a crawl from the
  start).
- **Ids** are the inode number plus the birth time where the file system keeps one (Windows,
  macOS, Linux with statx), so a rename, a move or an in-place edit keeps the id, and a new file
  on a reused inode number doesn't take an old file's. An editor's save-by-rename (a new inode
  at the same path) keeps the id too, by path. Hard links get an id from their path.
- **read()** returns the bytes only while the file is the version crawled: its
  `contentVersion` is size, modification time, change time and inode (the change time catches a
  rewrite that put the old modification time back). It is checked again when the file is opened
  (without following a link) and after the last byte; a file that changed meanwhile fails with
  `changed`. A rename changes the change time on most file systems, so after one the sync runner
  reads the file again (its bytes dedupe to the same content: no new version).
- **aclImport()**: file permissions don't travel (POSIX modes, ACLs and Windows DACLs name local
  accounts, not the organization's people). Every item gets the connection's `defaultAcl`
  (basis `configured`), or, without one, nothing (`owner-only`).
- **redirect()**: the item's `file:` URL, for the local agent to open natively (FR-20).
- **identity()**: the root's inode, birth time and file system type (`r1:…`), never its device
  number, which Linux and macOS give anew on a remount or a reboot (network and FUSE file
  systems, tmpfs, btrfs, overlays, external disks). Where the file system keeps no birth time,
  those numbers alone can't tell two disks of the same type apart (a fresh disk's root often has
  the same inode), so the connector always looks at a sample of the files its last snapshot
  recorded: if at least three in four are still there (same inode, and the same birth time where
  one is kept), it is the same folder and it answers what was recorded; otherwise it answers
  another identity, even when the numbers read the same. A folder whose last snapshot holds no
  files is accepted (there is nothing to compare). A crawl from the beginning drops the old
  snapshots, so the next check is against what it found. The check guards against accidents (a
  drive not mounted, another disk at the path), not against someone who controls the folder and
  can make its files look like the recorded ones. The sync runner records the answer outside the
  connector's state folder (core/jobs `source_syncs`) and refuses a sync, a crawl included, when
  another folder is at the root's path, until an admin accepts it. A delta and a resumed crawl
  make the same check against their own snapshot or journal.
- **Unreadable is not gone.** A folder it may not list, or an entry it may not stat (EACCES,
  EPERM, EBUSY as Windows answers for `pagefile.sys`, `hiberfil.sys` and the like), and another
  file system mounted inside the root (a disk mounted over a folder, a btrfs subvolume), are
  reported with a `warning` `unreadable`: a delta keeps what the snapshot had there (reporting
  nothing for it), and a crawl that met one defers its reconcile. `otherDevices: "skip"` makes a
  mount not there at all instead. Only ENOENT and ENOTDIR mean gone; other failures (an
  unreachable disk) fail the sync.
- **Hard links** (a file with more than one name): with `hardLinks: "index"` (default) each name
  is its own item, flagged with a `hard-link` warning (the bytes can change through another name,
  perhaps outside the root); with `"skip"` they are left out.

## Safety

Nothing outside the root is read. The root is used as configured (made absolute), not as
`realpath()` writes it: on Windows that turns a mapped network drive (`Z:\`) into its share
(`\\server\share`) and a mounted volume into `\\?\Volume{…}\`, whose `file:` URLs would name a
host. So a mapped drive works; a root configured as a network share or device path (UNC,
`\\server\share`, `\\?\…`) is refused, since opening such a URL makes Windows authenticate to
that server. Symbolic links and junctions are never followed, inside or outside the root (a
link's target inside the root is crawled where it is); other file systems mounted inside the
root are reported unreadable. `read`, `aclImport` and `redirect` accept only a location
inside the root with no link on the way, and the opened file must be the crawled inode. A root
that can't be reached is `retryable`, never "empty"; a delta refuses to run when another folder
has taken the root's path (a drive not mounted), rather than report every file deleted. Error
messages name the OS error code, never the path.

## Across operating systems

- Paths are built with `path.join` and `file:` URLs with `pathToFileURL`, from the root as
  configured; `realpath` only checks that the state folder isn't inside the root (macOS `/var`
  is `/private/var`, Windows 8.3 names, junctions and mapped drives).
- Long paths work where Node does (on Windows, past the old 260-character limit); entries whose
  path the OS refuses are left out.
- Case-insensitive file systems: nothing depends on path case; a rename that only changes case
  keeps the id. Names are reported as the file system gives them (macOS may decompose accents).
- Timestamps: the change time or the modification time must move for a change to show. On file
  systems with coarse timestamps (FAT: 2 s), a same-size rewrite within one tick is invisible
  until the next change.

## Limits

- Sockets, pipes and devices, and anything deeper than 256 folders, are left out.
- Cloud placeholders (OneDrive or iCloud files not downloaded: Windows'
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS or OFFLINE, macOS dataless files) can't be told apart
  from Node, which exposes neither attributes nor file flags: reading one downloads it. Point the
  connector at folders kept on the device, or turn "files on demand" off for them.
- Without birth times (some Linux file systems), a file renamed and edited between two deltas is
  reported deleted and created.
- Names that aren't valid Unicode (possible on Linux) can't be read back reliably.
- A name with a backslash (allowed on Linux), or a root whose first folder isn't plain ASCII
  (`/Données/…`), gives a `file:` URL the core refuses (`%5C`; a first folder that is neither a
  drive nor ASCII): the item is indexed without a URL, so enrichment can't read its content
  back, and it can't be opened natively.
- Snapshots are whole-folder JSON: fine for hundreds of thousands of entries, not for tens of
  millions.
