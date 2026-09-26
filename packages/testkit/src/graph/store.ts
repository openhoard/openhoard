import type { FakeAclEntry } from "../tenant/types.js";
import { inheritAcl, siteAcl } from "../tenant/generate.js";
import type { FakeItem, FakeTenant } from "../tenant/types.js";

/** An item as the store keeps it: the tenant's item plus the change sequence that last touched it. */
export interface StoredItem extends FakeItem {
  changeSeq: number;
  /** Bumped on every change (eTag). */
  version: number;
  /** Bumped only when the bytes change (cTag), so a rename never forces a re-download. */
  contentVersion: number;
}

export interface Tombstone {
  id: string;
  driveId: string;
  parentId: string | undefined;
  name: string;
  changeSeq: number;
}

export type ChangeListener = (change: {
  driveId: string;
  itemId: string;
  kind: "created" | "updated" | "deleted";
}) => void;

/**
 * Mutable copy of a fake tenant's drives, with a change log for delta queries. Every change
 * gets a new, strictly increasing sequence number; a delta token is simply "changes after N".
 *
 * The source tenant is never modified.
 */
export class TenantStore {
  private readonly items = new Map<string, StoredItem>();
  private readonly tombstones: Tombstone[] = [];
  private readonly listeners = new Set<ChangeListener>();
  private seq = 0;
  private nextId: number;

  constructor(readonly tenant: FakeTenant) {
    for (const item of tenant.items) {
      this.items.set(item.id, {
        ...item,
        labels: [...item.labels],
        acl: item.acl.map((a) => ({ ...a })),
        changeSeq: 0,
        version: 1,
        contentVersion: 1,
      });
    }
    this.nextId = tenant.items.length + 1;
  }

  /** The latest change sequence number. */
  get sequence(): number {
    return this.seq;
  }

  get(id: string): StoredItem | undefined {
    return this.items.get(id);
  }

  /** Items of a drive, in creation order. */
  inDrive(driveId: string): StoredItem[] {
    return [...this.items.values()].filter((i) => i.driveId === driveId);
  }

  children(driveId: string, parentId: string | undefined): StoredItem[] {
    return this.inDrive(driveId).filter((i) => i.parentId === parentId);
  }

  /** Items and tombstones of a drive changed after `since`, oldest change first. */
  changesSince(driveId: string, since: number): { items: StoredItem[]; deleted: Tombstone[] } {
    return {
      items: this.inDrive(driveId)
        .filter((i) => i.changeSeq > since)
        .sort((a, b) => a.changeSeq - b.changeSeq),
      deleted: this.tombstones.filter((t) => t.driveId === driveId && t.changeSeq > since),
    };
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Renames and/or edits a file. Content edits change the size and bump the version. */
  update(id: string, patch: { name?: string; size?: number; modifiedBy?: string }): StoredItem {
    const item = this.require(id);
    if (patch.name !== undefined) {
      validateName(patch.name);
      if (
        this.children(item.driveId, item.parentId).some(
          (s) => s.id !== id && s.name.toLowerCase() === patch.name?.toLowerCase(),
        )
      ) {
        throw new Error(`name conflict: ${patch.name}`);
      }
      item.name = patch.name;
      this.repath(item);
    }
    if (patch.size !== undefined) {
      if (item.kind !== "file") throw new TypeError("folders have no content");
      item.size = patch.size;
      item.contentVersion++;
      item.contentKey = `${item.id}@c${item.contentVersion}`;
    }
    if (patch.modifiedBy !== undefined) item.modifiedBy = patch.modifiedBy;
    this.touch(item, "updated");
    return item;
  }

  /**
   * Replaces an item's permissions with its own entries (breaking inheritance). Descendants
   * that inherit are updated too, and each shows up as changed in the next delta.
   */
  setAcl(id: string, acl: Omit<FakeAclEntry, "externalId" | "inherited">[]): StoredItem {
    const item = this.require(id);
    item.acl = acl.map((a) => ({ ...a, externalId: id, inherited: false }));
    this.touch(item, "updated");
    this.propagateAcl(item);
    return item;
  }

  /** Adds a file under `parentId` (or the drive root), inheriting the parent's permissions. */
  addFile(
    driveId: string,
    parentId: string | undefined,
    name: string,
    size: number,
    mime = "text/plain",
  ): StoredItem {
    validateName(name);
    const parent = parentId ? this.require(parentId) : undefined;
    if (parent && parent.kind !== "folder") throw new TypeError("parent must be a folder");
    const site = this.tenant.sites.find((s) => s.driveId === driveId);
    if (!site) throw new RangeError(`unknown drive ${driveId}`);
    if (this.children(driveId, parentId).some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`name conflict: ${name}`);
    }
    const id = `i-${String(this.nextId++).padStart(6, "0")}`;
    const now = new Date(Date.parse(this.tenant.now) + (this.seq + 1) * 1000).toISOString();
    const item: StoredItem = {
      id,
      siteId: site.id,
      driveId,
      parentId,
      kind: "file",
      name,
      path: `${parent?.path ?? ""}/${name}`,
      mime,
      size,
      createdAt: now,
      modifiedAt: now,
      createdBy: this.tenant.users[0]?.id ?? "u-0001",
      modifiedBy: this.tenant.users[0]?.id ?? "u-0001",
      etag: "",
      contentKey: id,
      labels: [],
      acl: inheritAcl(parent?.acl ?? siteAcl(site), id),
      changeSeq: 0,
      version: 0,
      contentVersion: 1,
    };
    this.items.set(id, item);
    this.touch(item, "created");
    return item;
  }

  /** Deletes an item and, for folders, everything below it. */
  delete(id: string): void {
    const item = this.require(id);
    for (const child of this.children(item.driveId, id)) this.delete(child.id);
    this.items.delete(id);
    this.seq++;
    this.tombstones.push({
      id,
      driveId: item.driveId,
      parentId: item.parentId,
      name: item.name,
      changeSeq: this.seq,
    });
    this.emit({ driveId: item.driveId, itemId: id, kind: "deleted" });
  }

  private touch(item: StoredItem, kind: "created" | "updated"): void {
    this.seq++;
    item.changeSeq = this.seq;
    item.version++;
    item.etag = `"{${item.id}},${item.version}"`;
    item.modifiedAt = new Date(Date.parse(this.tenant.now) + this.seq * 1000).toISOString();
    this.emit({ driveId: item.driveId, itemId: item.id, kind });
  }

  /** Re-derives inherited entries below `parent`; explicit entries (shares) are kept. */
  private propagateAcl(parent: StoredItem): void {
    for (const child of this.children(parent.driveId, parent.id)) {
      if (!child.acl.some((a) => a.inherited)) continue; // broke inheritance: unaffected
      const own = child.acl.filter((a) => !a.inherited);
      child.acl = [...inheritAcl(parent.acl, child.id), ...own];
      this.touch(child, "updated");
      this.propagateAcl(child);
    }
  }

  private repath(item: StoredItem): void {
    const parent = item.parentId ? this.items.get(item.parentId) : undefined;
    item.path = `${parent?.path ?? ""}/${item.name}`;
    for (const child of this.children(item.driveId, item.id)) this.repath(child);
  }

  private require(id: string): StoredItem {
    const item = this.items.get(id);
    if (!item) throw new RangeError(`unknown item ${id}`);
    return item;
  }

  private emit(change: Parameters<ChangeListener>[0]): void {
    for (const l of this.listeners) l(change);
  }
}

function validateName(name: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name.length > 255) {
    throw new RangeError(`invalid item name: ${JSON.stringify(name)}`);
  }
}
