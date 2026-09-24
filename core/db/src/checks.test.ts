import { describe, expect, it } from "vitest";
import { checkServer, compareVersions, DatabaseCheckError, type QueryRows } from "./checks.js";

interface Fake {
  num?: number;
  version?: string;
  tz?: string;
  /** What CREATE EXTENSION would install; null: pgvector isn't on the server at all. */
  vector?: string | null;
  /** The version created in this database; null: not created yet. */
  vectorInstalled?: string | null;
  provider?: string;
  collate?: string;
  locale?: string | null;
  encoding?: string;
  super?: boolean;
  bypass?: boolean;
}

/** Answers checkServer's three queries from `f`, defaulting to a good PostgreSQL 18. */
const fakeServer = (f: Fake = {}): QueryRows => {
  const s = {
    num: 180003,
    version: "18.3",
    tz: "UTC",
    vector: "0.8.1",
    vectorInstalled: null as string | null,
    provider: "b",
    collate: "C.UTF-8",
    locale: "C.UTF-8",
    encoding: "UTF8",
    super: false,
    bypass: false,
    ...f,
  };
  return (sql) => {
    if (sql.includes("server_version_num")) {
      return Promise.resolve([{ num: s.num, version: s.version, tz: s.tz }]);
    }
    if (sql.includes("pg_roles")) {
      return Promise.resolve([{ name: "openhoard", super: s.super, bypass: s.bypass }]);
    }
    if (sql.includes("pg_available_extensions")) {
      return Promise.resolve(
        s.vector === null ? [] : [{ available: s.vector, installed: s.vectorInstalled }],
      );
    }
    if (sql.includes("pg_database")) {
      return Promise.resolve([
        { provider: s.provider, collate: s.collate, locale: s.locale, encoding: s.encoding },
      ]);
    }
    return Promise.reject(new Error(`unexpected query: ${sql}`));
  };
};

describe("checkServer", () => {
  it("accepts PostgreSQL 18 with pgvector 0.8, UTC and builtin C.UTF-8", async () => {
    expect(await checkServer(fakeServer())).toEqual([]);
  });

  it("accepts PostgreSQL 17, the builtin C locale and libc C (PGlite)", async () => {
    expect(await checkServer(fakeServer({ num: 170006 }))).toEqual([]);
    expect(await checkServer(fakeServer({ locale: "C" }))).toEqual([]);
    expect(await checkServer(fakeServer({ provider: "c", collate: "C", locale: null }))).toEqual(
      [],
    );
    expect(
      await checkServer(fakeServer({ provider: "c", collate: "POSIX", locale: null })),
    ).toEqual([]);
  });

  it("rejects PostgreSQL 16 and stops there", async () => {
    const problems = await checkServer(fakeServer({ num: 160013, version: "16.13" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/PostgreSQL 16\.13 is too old/);
  });

  it("rejects a missing or old pgvector", async () => {
    expect(await checkServer(fakeServer({ vector: null }))).toEqual([
      expect.stringMatching(/pgvector extension is not installed on the server/),
    ]);
    expect(await checkServer(fakeServer({ vector: "0.6.0" }))).toEqual([
      expect.stringMatching(/pgvector 0\.6\.0 is too old/),
    ]);
    expect(await checkServer(fakeServer({ vector: "0.10.0" }))).toEqual([]);
  });

  it("checks the pgvector created in this database, not the newest on the server", async () => {
    // The server has 0.8.1, but this database still runs an older one it was created with.
    expect(await checkServer(fakeServer({ vector: "0.8.1", vectorInstalled: "0.7.4" }))).toEqual([
      expect.stringMatching(
        /pgvector 0\.7\.4 is too old.*installed in this database.*ALTER EXTENSION/,
      ),
    ]);
    // And a current one there is fine, whatever the server's default is.
    expect(await checkServer(fakeServer({ vector: "0.7.0", vectorInstalled: "0.8.0" }))).toEqual(
      [],
    );
    expect(await checkServer(fakeServer({ vector: "0.7.0", vectorInstalled: null }))).toEqual([
      expect.stringMatching(/pgvector 0\.7\.0 is too old.*this server would install/),
    ]);
  });

  it("rejects a session that is not in UTC", async () => {
    expect(await checkServer(fakeServer({ tz: "Etc/GMT+7" }))).toEqual([
      expect.stringMatching(/time zone is Etc\/GMT\+7/),
    ]);
  });

  it("rejects collations that do not sort by code point", async () => {
    const icu = await checkServer(fakeServer({ provider: "i", locale: "en-US" }));
    expect(icu).toEqual([expect.stringMatching(/\(icu en-US\) does not sort by code point/)]);
    const libc = await checkServer(fakeServer({ provider: "c", collate: "en_US.UTF-8" }));
    expect(libc).toEqual([expect.stringMatching(/\(libc en_US\.UTF-8\)/)]);
    const unicode = await checkServer(fakeServer({ locale: "PG_UNICODE_FAST" }));
    expect(unicode).toEqual([expect.stringMatching(/\(builtin PG_UNICODE_FAST\)/)]);
  });

  it("rejects superusers and BYPASSRLS roles, which skip row-level security", async () => {
    const message = /openhoard is a superuser or has BYPASSRLS/;
    expect(await checkServer(fakeServer({ super: true }))).toEqual([
      expect.stringMatching(message),
    ]);
    expect(await checkServer(fakeServer({ bypass: true }))).toEqual([
      expect.stringMatching(message),
    ]);
  });

  it("rejects a non-UTF-8 database", async () => {
    expect(await checkServer(fakeServer({ encoding: "LATIN1" }))).toEqual([
      expect.stringMatching(/encoding is LATIN1/),
    ]);
  });

  it("reports every problem at once", async () => {
    const problems = await checkServer(
      fakeServer({ tz: "America/Denver", vector: null, provider: "i", encoding: "SQL_ASCII" }),
    );
    expect(problems).toHaveLength(4);
    expect(await checkServer(fakeServer({ tz: "EST", super: true, vector: "0.5.0" }))).toHaveLength(
      3,
    );
  });

  it("treats missing rows as failures, not as passes", async () => {
    expect(await checkServer(() => Promise.resolve([]))).toEqual([
      expect.stringMatching(/too old/),
    ]);
    const onlyVersion: QueryRows = (sql) =>
      Promise.resolve(sql.includes("server_version_num") ? [{ num: 180000, tz: "UTC" }] : []);
    expect(await checkServer(onlyVersion)).toEqual([
      expect.stringMatching(/user undefined is a superuser or has BYPASSRLS/),
      expect.stringMatching(/pgvector/),
      expect.stringMatching(/encoding is undefined/),
      expect.stringMatching(/collation \(unknown\)/),
    ]);
  });
});

describe("compareVersions", () => {
  it.each([
    ["0.8.0", "0.8.0", 0],
    ["0.8", "0.8.0", 0],
    ["0.8.1", "0.8.0", 1],
    ["0.10.0", "0.8.1", 1],
    ["0.7.4", "0.8.0", -1],
    ["1.0.0-beta", "0.8.0", 1],
    ["garbage", "0.8.0", -1],
  ])("compareVersions(%j, %j) is %d", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe("DatabaseCheckError", () => {
  it("lists the problems", () => {
    const e = new DatabaseCheckError(["one", "two"]);
    expect(e.name).toBe("DatabaseCheckError");
    expect(e.problems).toEqual(["one", "two"]);
    expect(e.message).toContain("\n  - one\n  - two");
  });
});
