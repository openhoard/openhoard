import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApi, type Api, type Storage as Now, type StorageAsked } from "./api.js";
import { Storage } from "./storage.js";
import { placeText } from "./words.js";

/* Where files are kept: the setup guide, the test, the move, the old copies. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOCAL: Now = {
  kind: "local",
  settings: {},
  hasSecret: false,
  phase: "active",
  previous: null,
  total: 0,
  done: 0,
  failed: 0,
  lost: 0,
  lastError: null,
  changedAt: null,
  changedBy: null,
  changedByName: null,
  available: true,
  allowEndpoints: false,
  keepsFiles: true,
};
const OK = {
  ok: true,
  steps: [
    { step: "check" as const, ok: true },
    { step: "write" as const, ok: true },
    { step: "read" as const, ok: true },
    { step: "delete" as const, ok: true },
  ],
};

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function page(over: Partial<Api> = {}, now: Now = LOCAL) {
  const api = {
    storage: vi.fn(async () => now),
    testStorage: vi.fn<Api["testStorage"]>(async () => ({ ended: "tested", probe: OK })),
    keepStorage: vi.fn<Api["keepStorage"]>(async () => ({ ended: "done", outcome: "moving" })),
    retryStorageMove: vi.fn<Api["retryStorageMove"]>(async () => ({ ended: "done" })),
    removeOldCopies: vi.fn<Api["removeOldCopies"]>(async () => ({ ended: "done" })),
    ...over,
  } as unknown as Api;
  const signedOut = vi.fn();
  const signInAgain = vi.fn(async () => true);
  const show = () =>
    act(async () => {
      root.render(<Storage api={api} onSignedOut={signedOut} onSignInAgain={signInAgain} />);
    });
  return { api, show, signedOut, signInAgain };
}

const text = () => host.textContent ?? "";
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
const radio = (value: string) =>
  host.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`) as HTMLInputElement;
const field = (label: string) =>
  [...host.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(label))
    ?.querySelector("input") as HTMLInputElement;
const type = (label: string, value: string) =>
  act(async () => {
    const el = field(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
async function fillS3() {
  await click(radio("s3"));
  await type("Bucket name", "acme-hoard");
  await type("Region", "us-east-1");
  await type("Access key ID", "AKIAEXAMPLE");
  await type("Secret access key", "s3cr3t-access-key");
}

describe("the Storage page", () => {
  it("says where files are kept, and guides the setup of a bucket", async () => {
    const { show } = page();
    await show();
    expect(text()).toContain("This server's disk");
    await click(radio("s3"));
    expect(text()).toContain("What to set up in AWS first");
    expect(document.activeElement?.textContent).toBe("Amazon S3 (or S3-compatible)");
    await type("Bucket name", "acme-hoard");
    await type("Folder in the bucket (optional)", "openhoard");
    // The policy it shows is for that bucket and folder only.
    expect(host.querySelector(".snippet")?.textContent).toContain(
      "arn:aws:s3:::acme-hoard/openhoard/*",
    );
    // No other server to name unless this one allows it.
    expect(field("Endpoint")).toBeUndefined();
    await click(radio("azblob"));
    expect(text()).toContain("Access keys");
    expect(field("Storage account name")).toBeDefined();
  });

  it("tries the details, and lets them be used only once they worked, as tried", async () => {
    const { api, show } = page();
    await show();
    await fillS3();
    expect(button("Use this storage").disabled).toBe(true);
    await click(button("Test the connection"));
    expect(api.testStorage).toHaveBeenCalledWith({
      kind: "s3",
      bucket: "acme-hoard",
      region: "us-east-1",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "s3cr3t-access-key",
    });
    expect(text()).toContain("It works.");
    expect(text()).toContain("✓Passed:  Read it back");
    expect(button("Use this storage").disabled).toBe(false);
    // Changed since: tried again first.
    await type("Region", "eu-west-1");
    expect(button("Use this storage").disabled).toBe(true);
    expect(text()).toContain("test them again");
    await type("Region", "us-east-1");
    await click(button("Use this storage"));
    expect(api.keepStorage).toHaveBeenCalledWith(expect.objectContaining({ bucket: "acme-hoard" }));
  });

  it("says why a try failed, field by field or step by step", async () => {
    const probe = {
      ok: false,
      steps: [
        { step: "write" as const, ok: false, problem: "denied" as const, code: "AccessDenied" },
      ],
    };
    const testStorage = vi
      .fn<Api["testStorage"]>()
      .mockResolvedValueOnce({ ended: "tested", probe })
      .mockResolvedValueOnce({
        ended: "invalid",
        field: "bucket",
        message: "a bucket's name is 3 to 63 lower-case letters",
      });
    const { show } = page({ testStorage });
    await show();
    await fillS3();
    await click(button("Test the connection"));
    expect(text()).toContain("✗Failed:  Write a small test file: The keys were refused");
    expect(text()).toContain("AccessDenied");
    expect(button("Use this storage").disabled).toBe(true);
    await click(button("Test the connection"));
    expect(field("Bucket name").getAttribute("aria-invalid")).toBe("true");
    expect(text()).toContain("lower-case letters");
  });

  it("asks for a fresh sign-in when the server does", async () => {
    const { show, signInAgain } = page({
      keepStorage: vi.fn(async (): Promise<StorageAsked> => ({ ended: "sign-in-again" })),
    });
    await show();
    await fillS3();
    await click(button("Test the connection"));
    await click(button("Use this storage"));
    expect(text()).toContain("takes a recent sign-in");
    await click(button("Sign out and in again"));
    expect(signInAgain).toHaveBeenCalled();
  });

  it("follows a move, and offers what to do after it", async () => {
    const moving: Now = {
      ...LOCAL,
      kind: "s3",
      settings: { bucket: "acme-hoard", region: "us-east-1", accessKeyId: "AKIAEXAMPLE" },
      hasSecret: true,
      phase: "moving",
      previous: { kind: "local", settings: {} },
      total: 40,
      done: 10,
    };
    const going = page(
      {},
      {
        ...moving,
        changedAt: "2026-10-15T14:11:00Z",
        changedBy: "user:usr_1",
        changedByName: "Steve",
      },
    );
    await going.show();
    expect(text()).toContain("The Amazon S3 bucket acme-hoard (us-east-1)");
    expect(text()).toMatch(/Chosen .* by Steve\./);
    expect(text()).toContain("From this server's own disk.");
    expect(text()).toContain("Copying files over");
    expect(text()).toContain("10 files of 40");
    expect(host.querySelector("progress")?.getAttribute("value")).toBe("10");
    // No other change while one is underway.
    expect(radio("s3")).toBeNull();
    // A move whose job was lost is started again from here.
    await click(button("Start it again"));
    expect(going.api.retryStorageMove).toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(host);
    const failed = page(
      {},
      { ...moving, phase: "active", done: 38, failed: 1, lost: 1, lastError: "b3t:…: unreachable" },
    );
    await failed.show();
    expect(text()).toContain("1 file couldn't be copied or removed (the last: b3t:…: unreachable)");
    expect(text()).toContain("1 file was in neither place");
    await click(button("Try the move again"));
    expect(failed.api.retryStorageMove).toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(host);
    const done = page({}, { ...moving, phase: "active", done: 40 });
    await done.show();
    expect(text()).toContain("Every file was copied");
    await click(button("Remove the old copies"));
    // Asked twice: it can't be undone from here.
    expect(done.api.removeOldCopies).not.toHaveBeenCalled();
    expect(text()).toContain("This can't be undone from here.");
    await click(button("Yes, remove them"));
    expect(done.api.removeOldCopies).toHaveBeenCalled();
  });

  it("says a bucket by its name, region and folder", () => {
    expect(placeText("s3", { bucket: "acme", region: "us-east-1", prefix: "oh" })).toBe(
      "the Amazon S3 bucket acme (us-east-1), folder oh",
    );
    expect(placeText("s3", { bucket: "acme", endpoint: "https://r2.example" })).toBe(
      "the S3-compatible bucket acme at https://r2.example",
    );
    expect(placeText("azblob", { accountName: "acct", container: "c" })).toBe(
      "the Azure Blob container c in storage account acct",
    );
  });
});

describe("storage over the API", () => {
  it("reads how each request ended", async () => {
    const answers = [
      Response.json(OK),
      Response.json({ error: "bad", field: "region" }, { status: 400 }),
      Response.json(
        {
          error: "didn't work",
          probe: { ok: false, steps: [{ step: "write", ok: false, problem: "denied" }] },
        },
        { status: 409 },
      ),
      Response.json({ error: "a move is underway" }, { status: 409 }),
      Response.json({ error: "sign in again", signIn: "/auth/sign-in" }, { status: 403 }),
      Response.json({ outcome: "moving" }),
      new Response("", { status: 500 }),
    ];
    const fetcher = vi.fn(async () => answers.shift() as Response);
    const api = createApi(fetcher as unknown as typeof fetch);
    const s3 = { kind: "s3" as const, bucket: "b", region: "r", accessKeyId: "k" };
    expect(await api.testStorage(s3)).toEqual({ ended: "tested", probe: OK });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/admin/storage/test",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ choice: s3 }) }),
    );
    expect(await api.testStorage(s3)).toEqual({
      ended: "invalid",
      field: "region",
      message: "bad",
    });
    expect(await api.keepStorage(s3)).toEqual({
      ended: "probe-failed",
      probe: { ok: false, steps: [{ step: "write", ok: false, problem: "denied" }] },
    });
    expect(await api.keepStorage(s3)).toEqual({ ended: "busy", message: "a move is underway" });
    expect(await api.removeOldCopies()).toEqual({ ended: "sign-in-again" });
    expect(await api.keepStorage(s3)).toEqual({ ended: "done", outcome: "moving" });
    expect(await api.retryStorageMove()).toEqual({ ended: "failed" });
  });

  it("refuses a storage answer that isn't one", async () => {
    const api = createApi((async () =>
      Response.json({ kind: "ftp", phase: "active" })) as unknown as typeof fetch);
    await expect(api.storage()).rejects.toBeInstanceOf(ApiError);
  });
});
