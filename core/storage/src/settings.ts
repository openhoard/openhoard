import type { StorageConfig } from "./store.js";

/*
 * Where a tenant's admin asks for its blobs to live (tenant-storage.ts), as the admin app sends
 * it, checked here before anything connects anywhere.
 *
 * - `local`: the server's own disk, the default.
 * - `s3`: a bucket on Amazon S3 (by region), or with `endpoint` on another S3-compatible service
 *   (Cloudflare R2, MinIO, Backblaze…) when the server allows other endpoints.
 * - `azblob`: a container in an Azure Storage account.
 *
 * A tenant's bucket is reached with the keys its admin gives, and nothing else: never the
 * server's own cloud identity (its environment, an EC2 instance role), which could reach
 * buckets that aren't the tenant's. An endpoint other than the cloud's own is a server a tenant
 * admin names for this server to connect to, so it is refused unless whoever runs the server
 * allows it (`allowEndpoints`): otherwise any tenant's admin could make the server probe its
 * own network.
 */

export type StorageChoice =
  | { kind: "local" }
  | {
      kind: "s3";
      bucket: string;
      region: string;
      /** Another S3-compatible service's address; absent for Amazon S3. */
      endpoint?: string;
      /** A folder inside the bucket to keep OpenHoard's blobs in. */
      prefix?: string;
      accessKeyId: string;
      /** The secret key: given when set or changed, never read back. */
      secretAccessKey?: string;
    }
  | {
      kind: "azblob";
      accountName: string;
      container: string;
      /** Another endpoint (Azurite, a sovereign cloud); absent for the public cloud. */
      endpoint?: string;
      prefix?: string;
      /** The account key: given when set or changed, never read back. */
      accountKey?: string;
    };

/** The part of a choice that is stored in the clear and shown to admins. */
export type StorageSettings = Record<string, string>;

/** A choice that isn't one: `field` says which, `message` why, in an admin's words. */
export class StorageChoiceError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "StorageChoiceError";
  }
}

export interface ChoiceRules {
  /** Whether endpoints other than the clouds' own may be named. Default false. */
  allowEndpoints?: boolean;
}

const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IP_LIKE = /^\d+\.\d+\.\d+\.\d+$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ACCESS_KEY_ID = /^[A-Za-z0-9._+/=-]{4,128}$/;
const SECRET = /^[\x21-\x7e]{8,512}$/;
const AZ_ACCOUNT = /^[a-z0-9]{3,24}$/;
const AZ_CONTAINER = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/;
const PREFIX_PART = /^[A-Za-z0-9._-]{1,100}$/;

function text(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new StorageChoiceError(field, `${field} is text`);
  return value.trim();
}

function required(value: unknown, field: string, what: string): string {
  const v = text(value, field);
  if (v === undefined) throw new StorageChoiceError(field, `${what} is needed`);
  return v;
}

/** `a/b`, each part letters, digits, `.`, `_` or `-`; no `..`, no leading or trailing `/`. */
function prefixOf(value: unknown): string | undefined {
  const v = text(value, "prefix");
  if (v === undefined) return undefined;
  const parts = v.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length > 8 || parts.some((p) => !PREFIX_PART.test(p) || p === "." || p === "..")) {
    throw new StorageChoiceError(
      "prefix",
      "the folder is names of letters, digits, '.', '_' or '-', separated by '/'",
    );
  }
  return parts.join("/");
}

function endpointOf(
  value: unknown,
  rules: ChoiceRules,
  /** An Azure emulator's endpoint names the account in its path (Azurite's). */
  accountPath?: string,
): string | undefined {
  const v = text(value, "endpoint");
  if (v === undefined) return undefined;
  if (rules.allowEndpoints !== true) {
    throw new StorageChoiceError(
      "endpoint",
      "this server only connects to Amazon S3 and Azure's own addresses; whoever runs it can allow others (storage.allowEndpoints)",
    );
  }
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new StorageChoiceError(
      "endpoint",
      "the endpoint is an address such as https://s3.example.com",
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" &&
      url.pathname !== "" &&
      (accountPath === undefined || url.pathname.replace(/\/$/, "") !== `/${accountPath}`))
  ) {
    throw new StorageChoiceError(
      "endpoint",
      "the endpoint is a plain address (https://host or https://host:port), with no path, query or credentials",
    );
  }
  return url.pathname.length > 1 ? `${url.origin}${url.pathname.replace(/\/$/, "")}` : url.origin;
}

/**
 * A choice as the admin app sends it, checked. Throws StorageChoiceError for the first field
 * that isn't right. The secret may be absent (kept as it was, when the place doesn't change).
 */
export function checkChoice(input: unknown, rules: ChoiceRules = {}): StorageChoice {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new StorageChoiceError("kind", "a choice is an object");
  }
  const o = input as Record<string, unknown>;
  switch (o.kind) {
    case "local":
      return { kind: "local" };
    case "s3": {
      const bucket = required(o.bucket, "bucket", "the bucket's name");
      if (!S3_BUCKET.test(bucket) || bucket.includes("..") || IP_LIKE.test(bucket)) {
        throw new StorageChoiceError(
          "bucket",
          "a bucket's name is 3 to 63 lower-case letters, digits, '.' or '-', as S3 names it",
        );
      }
      const region = required(o.region, "region", "the bucket's region");
      if (!REGION.test(region)) {
        throw new StorageChoiceError("region", "a region is written like us-east-1");
      }
      const accessKeyId = required(o.accessKeyId, "accessKeyId", "the access key ID");
      if (!ACCESS_KEY_ID.test(accessKeyId)) {
        throw new StorageChoiceError("accessKeyId", "that isn't an access key ID");
      }
      const secretAccessKey = text(o.secretAccessKey, "secretAccessKey");
      if (secretAccessKey !== undefined && !SECRET.test(secretAccessKey)) {
        throw new StorageChoiceError("secretAccessKey", "that isn't a secret access key");
      }
      const endpoint = endpointOf(o.endpoint, rules);
      const prefix = prefixOf(o.prefix);
      return {
        kind: "s3",
        bucket,
        region,
        accessKeyId,
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(prefix === undefined ? {} : { prefix }),
        ...(secretAccessKey === undefined ? {} : { secretAccessKey }),
      };
    }
    case "azblob": {
      const accountName = required(o.accountName, "accountName", "the storage account's name");
      if (!AZ_ACCOUNT.test(accountName)) {
        throw new StorageChoiceError(
          "accountName",
          "a storage account's name is 3 to 24 lower-case letters and digits",
        );
      }
      const container = required(o.container, "container", "the container's name");
      if (!AZ_CONTAINER.test(container)) {
        throw new StorageChoiceError(
          "container",
          "a container's name is 3 to 63 lower-case letters, digits and single '-'",
        );
      }
      const accountKey = text(o.accountKey, "accountKey");
      if (accountKey !== undefined && !/^[A-Za-z0-9+/]{20,200}={0,2}$/.test(accountKey)) {
        throw new StorageChoiceError("accountKey", "an account key is the base64 text Azure shows");
      }
      const endpoint = endpointOf(o.endpoint, rules, accountName);
      const prefix = prefixOf(o.prefix);
      return {
        kind: "azblob",
        accountName,
        container,
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(prefix === undefined ? {} : { prefix }),
        ...(accountKey === undefined ? {} : { accountKey }),
      };
    }
    default:
      throw new StorageChoiceError("kind", "storage is local, s3 or azblob");
  }
}

/** A choice's secret, if it carries one. */
export function secretOf(choice: StorageChoice): string | undefined {
  return choice.kind === "s3"
    ? choice.secretAccessKey
    : choice.kind === "azblob"
      ? choice.accountKey
      : undefined;
}

/** A choice's settings: everything but the secret, as stored and shown. */
export function settingsOf(choice: StorageChoice): StorageSettings {
  const { kind: _kind, ...rest } = choice as Record<string, string>;
  delete rest.secretAccessKey;
  delete rest.accountKey;
  return rest;
}

/** Whether two choices are the same place (the same blobs), whatever their keys. */
export function samePlace(
  a: { kind: string; settings: StorageSettings },
  b: { kind: string; settings: StorageSettings },
): boolean {
  if (a.kind !== b.kind) return false;
  const place = (s: StorageSettings) =>
    JSON.stringify([s.bucket, s.region, s.endpoint, s.prefix, s.accountName, s.container]);
  return place(a.settings) === place(b.settings);
}

/**
 * The store configuration for a tenant's choice: its settings and its secret (opened). Reaches
 * the bucket with that secret only (no ambient credentials).
 */
export function storeConfigOf(
  kind: "s3" | "azblob",
  settings: StorageSettings,
  secret: string,
): StorageConfig {
  const root = settings.prefix === undefined ? undefined : `/${settings.prefix}/`;
  if (kind === "s3") {
    return {
      kind: "s3",
      bucket: settings.bucket as string,
      region: settings.region as string,
      ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
      accessKeyId: settings.accessKeyId as string,
      secretAccessKey: secret,
      ...(root === undefined ? {} : { root }),
      ambientCredentials: false,
    };
  }
  return {
    kind: "azblob",
    container: settings.container as string,
    accountName: settings.accountName as string,
    accountKey: secret,
    endpoint: settings.endpoint ?? `https://${settings.accountName}.blob.core.windows.net`,
    ...(root === undefined ? {} : { root }),
  };
}
