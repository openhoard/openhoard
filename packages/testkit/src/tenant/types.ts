import type { SourceAcl } from "@openhoard/sdk";

/** A person in the fake tenant. Guests are external people invited to a site or file. */
export interface FakeUser {
  id: string;
  /** Sign-in name. Internal users are `first.last@<domain>`; guests keep their own domain. */
  upn: string;
  displayName: string;
  department: string;
  guest: boolean;
  /** False for people who have left: their files remain, but they can no longer sign in. */
  active: boolean;
}

export interface FakeGroup {
  id: string;
  displayName: string;
  /** Direct members (user ids). Groups do not nest in v0. */
  members: string[];
}

export interface FakeSite {
  id: string;
  /** URL-safe name, e.g. `finance`. */
  name: string;
  displayName: string;
  webUrl: string;
  /** Groups whose members can read everything in the site unless an item breaks inheritance. */
  readerGroups: string[];
  /** Groups whose members can also write. */
  writerGroups: string[];
  driveId: string;
}

export type ItemKind = "file" | "folder";

export interface FakeItem {
  id: string;
  siteId: string;
  driveId: string;
  /** Parent folder id, or undefined for items in the drive root. */
  parentId: string | undefined;
  kind: ItemKind;
  name: string;
  /** Full path from the drive root, e.g. `/Clients/Acme/Q3 Forecast.xlsx`. */
  path: string;
  mime: string;
  /** Declared size in bytes. {@link contentStream} produces exactly this many bytes. */
  size: number;
  createdAt: string;
  modifiedAt: string;
  createdBy: string;
  modifiedBy: string;
  /** Changes whenever content or metadata changes, like a Graph eTag. */
  etag: string;
  /** Items with the same content key have byte-identical content (seeded duplicates). */
  contentKey: string;
  /** Ground-truth labels, e.g. `client:acme`, `type:invoice`, `sensitivity:confidential`. */
  labels: string[];
  /**
   * Access entries on this item as a source would report them. Entries copied from the site
   * or a parent folder carry `inherited: true`. Items that break inheritance carry only their
   * own entries.
   */
  acl: SourceAcl[];
  /** A unique token planted in the name and content of restricted files (leak harness). */
  canary?: string;
}

/**
 * Deliberate problems the generator plants, so a File Health Report or clean-up feature can be
 * tested for recall against known answers.
 */
export type ProblemKind =
  | "anyone-link"
  | "external-guest"
  | "orphaned-owner"
  | "duplicate"
  | "stale"
  | "broken-inheritance"
  | "sensitive-in-open-site"
  | "injection-filename"
  | "huge-file"
  | "long-path";

export interface SeededProblem {
  kind: ProblemKind;
  itemId: string;
  detail: string;
}

export interface FakeTenant {
  id: string;
  seed: string;
  domain: string;
  /** The generator's notion of "now". All dates are before it. */
  now: string;
  users: FakeUser[];
  groups: FakeGroup[];
  sites: FakeSite[];
  items: FakeItem[];
  problems: SeededProblem[];
}
