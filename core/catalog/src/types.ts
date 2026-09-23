import type { Exposure, Visibility } from "@openhoard/core-policy";

export type Zone = "managed" | "indexed" | "local-only" | "code";

/** The logical file. */
export interface CatalogObject {
  id: string;
  tenantId: string;
  title: string;
  zone: Zone;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

/** One saved state of an object, pointing at an immutable blob. */
export interface Version {
  id: string;
  objectId: string;
  blobHash: string;
  size: number;
  mime: string;
  authorId: string;
  createdAt: string;
}

export interface Facet {
  key: string; // e.g. "client", "sensitivity"
  values: FacetValue[];
}

export interface FacetValue {
  value: string;
  approved: boolean;
  visibility?: Visibility;
  exposure?: Exposure;
}

export interface ObjectTag {
  objectId: string;
  tag: string; // "facet:value"
  appliedBy: "rule" | "model" | "user" | "pack";
  confidence: number;
  reviewed: boolean;
}
