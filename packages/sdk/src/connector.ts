import type { PluginManifest } from "@openhoard/schemas";

/** An item as a source reports it. The core turns these into catalog objects and versions. */
export interface SourceItem {
  externalId: string;
  path: string;
  title: string;
  mime: string;
  size: number;
  etag: string;
  modifiedAt: string;
  modifiedBy?: string;
}

/** One permission entry as the source reports it (imported as grants by the core). */
export interface SourceAcl {
  externalId: string;
  principal: string; // "user:…", "group:…", "anyone-with-link", "guest:…"
  role: "read" | "write" | "owner";
  expiresAt?: string;
  inherited: boolean;
}

export interface Page<T> {
  items: T[];
  /** Opaque checkpoint; pass back to resume. Absent when done. */
  next?: string;
}

/** Contract every connector implements (interface v1, see docs/architecture.md). */
export interface Connector {
  manifest: PluginManifest;
  crawl(checkpoint?: string): Promise<Page<SourceItem>>;
  delta(token?: string): Promise<{ changed: SourceItem[]; deleted: string[]; token: string }>;
  read(externalId: string): Promise<ReadableStream<Uint8Array>>;
  aclImport?(externalId: string): Promise<SourceAcl[]>;
  write?(externalId: string, body: ReadableStream<Uint8Array>): Promise<SourceItem>;
  redirect?(externalId: string, target: string): Promise<void>;
}

/** Identity helper that gives plugin authors type checking and a single, greppable entry point. */
export function defineConnector(connector: Connector): Connector {
  return connector;
}
